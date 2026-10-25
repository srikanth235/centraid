//! Agenda's home, through the door a shell uses (#1135): Day, Schedule, Waiting
//! and To-do, Search as a mode, the More and filing sheets, the quick add, dated
//! tasks drawn on their days, the Overdue group and the absence notice, project
//! containers, the calendar toggles and the window and anchor.
//!
//! The vault is the example scenario on the machine's clock, so every test makes
//! its own rows under titles of its own (`Zq …`) and asserts on those, or clears
//! what it must see empty.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::{Field, Keyed};
use centraid_screens::kit::civil;
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use centraid_screens::{Runtime, agenda};
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::{Content, Sheet};
use wire::screen_event::Kind as E;

struct Rig {
    driver: Driver,
    id: u64,
    zone: String,
    seq: u64,
}

fn rig(destination: Dest) -> Rig {
    rig_with(destination, "")
}

fn rig_with(destination: Dest, quick_add_title: &str) -> Rig {
    let mut driver = Driver::with_runtime(Runtime::new(
        agenda::registry(),
        vec![(
            agenda::TAB.to_owned(),
            agenda::routes::home(destination, quick_add_title),
        )],
    ));
    driver.start();
    let id = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    Rig {
        driver,
        id,
        zone: "UTC".to_owned(),
        seq: 0,
    }
}

fn view_of(driver: &Driver, id: u64) -> &wire::AgendaHomeState {
    match &driver.view(id).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => state,
        other => panic!("not Agenda's home: {other:?}"),
    }
}

impl Rig {
    fn state(&self) -> &wire::AgendaHomeState {
        view_of(&self.driver, self.id)
    }

    fn data(&self) -> &wire::AgendaHomeData {
        match &self.state().content {
            Some(Content::Data(data)) => data,
            other => panic!("expected data, found {other:?}"),
        }
    }

    fn todo(&self) -> &wire::AgendaTodo {
        self.data().todo.as_ref().expect("To-do's data")
    }

    fn quick(&self) -> &wire::TodoQuickAdd {
        self.state().quick_add.as_ref().expect("the quick add")
    }

    fn status(&self) -> Option<&wire::StatusLine> {
        self.state().status.as_ref()
    }

    fn send(&mut self, kind: H) {
        self.driver.send(
            self.id,
            E::AgendaHome(wire::AgendaHomeEvent { kind: Some(kind) }),
        );
    }

    /// Let the change events a write caused reach the screen.
    fn settle(&mut self) {
        self.driver.pump(Duration::from_millis(400));
    }

    fn band(&mut self, key: &str) {
        self.send(H::Band(wire::agenda_home_event::BandPicked {
            key: key.to_owned(),
        }));
    }

    fn step(&mut self, days: i32) {
        self.send(H::DayStepped(wire::agenda_home_event::DayStepped { days }));
    }

    fn open_search(&mut self) {
        self.send(H::SearchOpened(wire::agenda_home_event::SearchOpened {}));
    }

    fn term(&mut self, term: &str) {
        self.send(H::SearchTerm(wire::agenda_home_event::SearchTermChanged {
            term: term.to_owned(),
        }));
    }

    fn close_search(&mut self) {
        self.send(H::SearchClosed(wire::agenda_home_event::SearchClosed {}));
    }

    fn more_row(&mut self, key: &str) {
        self.send(H::MoreRow(wire::agenda_home_event::MoreRowPicked {
            key: key.to_owned(),
        }));
    }

    fn check(&mut self, task_id: &str) {
        self.send(H::TaskChecked(wire::agenda_home_event::TaskChecked {
            task_id: task_id.to_owned(),
        }));
    }

    fn today(&self) -> String {
        self.data().today.clone()
    }

    /// `days` from the core's today.
    fn day(&self, days: i64) -> String {
        civil::plus_days(&self.today(), days).expect("a real day")
    }

    /// Write as another surface would, under a key of its own.
    fn act(&mut self, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
        self.seq += 1;
        let request = request.into().keyed(format!("zq-test:{}", self.seq));
        self.driver.act(request)
    }

    /// [`Self::act`], and demand the vault accept it.
    fn write(&mut self, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
        let done = self.act(request);
        assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");
        done
    }

    fn read(&self, request: impl Into<wire::LoadRequest>) -> wire::app_query_response::Answer {
        let mut request = request.into();
        request.zone.clone_from(&self.zone);
        self.driver
            .handle
            .load(&request)
            .expect("the load door answers")
            .answer
            .and_then(|answer| answer.answer)
            .expect("an answer")
    }

    /// Make the device live in `zone`.
    fn in_zone(&mut self, zone: &str) {
        self.zone = zone.to_owned();
        self.driver
            .call(wire::screen_request::Kind::Environment(wire::Environment {
                locale: "en".to_owned(),
                zone: zone.to_owned(),
                ..Default::default()
            }));
    }

    fn event(&mut self, id: &str, title: &str, starts: &str, ends: Option<&str>) {
        let zone = self.zone.clone();
        self.write(act::agenda::Propose {
            id: Some(id.to_owned()),
            title: title.to_owned(),
            starts: starts.to_owned(),
            ends: ends.map_or(Field::Keep, |ends| Field::Is(ends.to_owned())),
            busy: Some(false),
            zone: Field::Is(zone),
            ..Default::default()
        });
    }

    fn all_day(&mut self, id: &str, title: &str, first: &str, last: &str) {
        self.write(act::agenda::Propose {
            id: Some(id.to_owned()),
            title: title.to_owned(),
            starts: first.to_owned(),
            ends: Field::Is(last.to_owned()),
            timing: Some(act::agenda::ProposeTiming::AllDay),
            busy: Some(false),
            ..Default::default()
        });
    }

    fn task(&mut self, id: &str, title: &str, due: Option<&str>) {
        let zone = self.zone.clone();
        self.write(act::agenda::AddTask {
            id: Some(id.to_owned()),
            title: title.to_owned(),
            due: due.map_or(Field::Keep, |due| Field::Is(due.to_owned())),
            zone: Field::Is(zone),
            ..Default::default()
        });
    }

    /// The owner's party id, and another person's.
    fn people(&self) -> (String, String) {
        let wire::app_query_response::Answer::AgendaParties(parties) =
            self.read(load::agenda::Parties {})
        else {
            panic!("parties");
        };
        let me = parties.me.clone().expect("an owner");
        let other = parties
            .parties
            .iter()
            .find(|p| p.party_id != me)
            .expect("another person")
            .party_id
            .clone();
        (me, other)
    }

    /// Trash every event and delete every task the scenario seeded.
    fn clear(&mut self) {
        let far = format!(
            "{}T00:00:00Z",
            civil::plus_days(&self.today(), 800).expect("day")
        );
        let wire::app_query_response::Answer::AgendaUpcoming(upcoming) =
            self.read(load::agenda::Upcoming {
                from: Some("2000-01-01T00:00:00Z".to_owned()),
                to: Some(far),
            })
        else {
            panic!("upcoming");
        };
        let mut seen = std::collections::BTreeSet::new();
        for event in upcoming.events {
            if seen.insert(event.event_id.clone()) {
                self.write(act::agenda::TrashEvent {
                    event_id: event.event_id,
                });
            }
        }
        for view in [
            load::agenda::BoardView::All,
            load::agenda::BoardView::Logbook,
        ] {
            let wire::app_query_response::Answer::TasksBoard(board) =
                self.read(load::agenda::Board {
                    limit: 500,
                    view: Some(view),
                    project_id: None,
                })
            else {
                panic!("board");
            };
            for task in board.groups.iter().flat_map(|group| &group.tasks) {
                let done = self.act(act::agenda::DeleteTask {
                    task_id: task.task_id.clone(),
                });
                assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");
            }
        }
        self.settle();
    }
}

fn titles(section: &wire::AgendaDaySection, names: &[&str]) -> Vec<String> {
    section
        .items
        .iter()
        .filter_map(|item| match &item.kind {
            Some(wire::agenda_row_item::Kind::Event(row)) => Some(row.title.clone()),
            Some(wire::agenda_row_item::Kind::Task(row)) => Some(row.title.clone()),
            Some(wire::agenda_row_item::Kind::NowLine(_)) => Some("NOW".to_owned()),
            None => None,
        })
        .filter(|title| title == "NOW" || names.contains(&title.as_str()))
        .collect()
}

fn events_of(section: &wire::AgendaDaySection) -> Vec<&wire::AgendaEventRow> {
    section
        .items
        .iter()
        .filter_map(|item| match &item.kind {
            Some(wire::agenda_row_item::Kind::Event(row)) => Some(row),
            _ => None,
        })
        .collect()
}

fn tasks_of(section: &wire::AgendaDaySection) -> Vec<&wire::TodoRow> {
    section
        .items
        .iter()
        .filter_map(|item| match &item.kind {
            Some(wire::agenda_row_item::Kind::Task(row)) => Some(row),
            _ => None,
        })
        .collect()
}

fn section<'a>(data: &'a wire::AgendaHomeData, day: &str) -> Option<&'a wire::AgendaDaySection> {
    data.days.iter().find(|section| section.day == day)
}

/// Every row of every day that is one of `names`, as `day: title`.
fn mine(data: &wire::AgendaHomeData, names: &[&str]) -> Vec<String> {
    data.days
        .iter()
        .flat_map(|day| {
            let rows: Vec<String> = events_of(day)
                .iter()
                .map(|row| row.title.clone())
                .chain(tasks_of(day).iter().map(|row| row.title.clone()))
                .filter(|title| names.contains(&title.as_str()))
                .map(|title| format!("{}: {title}", day.day))
                .collect();
            rows
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Opening, the band, the window
// ---------------------------------------------------------------------------

#[test]
fn opening_lands_on_day_at_the_today_the_core_names() {
    let r = rig(Dest::Day);
    let state = r.state();
    assert_eq!(state.destination, Dest::Day as i32);
    // NOT A DEVICE-CLOCK GUESS: the anchor is the day the answer names.
    assert_eq!(state.anchor_day, r.today());
    let toolbar = state.toolbar.as_ref().unwrap();
    assert!(toolbar.shown && toolbar.at_today);
    assert_eq!(toolbar.range_label, "Today");
    assert_eq!(toolbar.month_label, month_year(&r.today()));
    // THE BAND, computed: places only, then More (R-CHROME-5), no Search tab.
    assert_eq!(
        state
            .band
            .iter()
            .map(|tab| tab.key.as_str())
            .collect::<Vec<_>>(),
        ["day", "schedule", "waiting", "todo", "more"]
    );
    assert_eq!(
        state
            .band
            .iter()
            .map(|tab| tab.icon_key.as_str())
            .collect::<Vec<_>>(),
        ["Clock", "List", "Inbox", "Todo", "MoreHoriz"]
    );
    assert_eq!(
        state
            .band
            .iter()
            .filter(|tab| tab.current)
            .map(|tab| tab.key.as_str())
            .collect::<Vec<_>>(),
        ["day"]
    );
    assert_eq!(state.chrome.as_ref().unwrap().new_event, "New event");
    // THE HEADER PLUS says Add: its sheet adds an event or a task (R-1128-Z1), and
    // Day's Plus pushes that sheet, on the anchor day, not the quick-add bar.
    assert_eq!(state.add_label, "Add");
    assert!(!state.add_opens_quick_add);
    assert_eq!(
        state.new_event,
        Some(agenda::routes::editor(
            "",
            "",
            None,
            &r.today(),
            wire::AgendaEditorKind::Unspecified
        ))
    );
    let landing = r.data().landing.as_ref().unwrap();
    assert_eq!(landing.day, r.today());
    assert!(landing.now_line);
    assert_eq!(r.data().catch_up, Some(agenda::routes::catch_up()));
}

#[test]
fn a_destination_from_the_route_lands_there() {
    let r = rig(Dest::Schedule);
    assert_eq!(r.state().destination, Dest::Schedule as i32);
    assert_eq!(
        r.state().toolbar.as_ref().unwrap().range_label,
        "From today"
    );
    assert_eq!(
        r.state()
            .band
            .iter()
            .filter(|t| t.current)
            .map(|t| t.key.as_str())
            .collect::<Vec<_>>(),
        ["schedule"]
    );

    let w = rig(Dest::Waiting);
    assert_eq!(w.state().destination, Dest::Waiting as i32);

    // NOTES' "SEND TO AGENDA" names To-do as the place and waits in the bar, focused.
    let s = rig_with(Dest::Unspecified, "  Buy milk ");
    assert_eq!(s.state().destination, Dest::Todo as i32);
    assert_eq!(s.quick().title, "Buy milk");
    assert!(s.quick().drawn && s.quick().focused);
}

#[test]
fn a_day_step_moves_the_window_and_the_bar_names_it() {
    let mut r = rig(Dest::Day);
    r.event(
        "zq-step",
        "Zq Step",
        &format!("{}T09:00", r.day(1)),
        Some(&format!("{}T10:00", r.day(1))),
    );
    r.settle();
    r.step(1);
    assert_eq!(r.state().anchor_day, r.day(1));
    let toolbar = r.state().toolbar.clone().unwrap();
    assert_eq!(toolbar.range_label, "Tomorrow");
    assert!(!toolbar.at_today);
    assert_eq!(
        mine(r.data(), &["Zq Step"]),
        [format!("{}: Zq Step", r.state().anchor_day)]
    );
    r.step(-2);
    assert_eq!(r.state().toolbar.as_ref().unwrap().range_label, "Yesterday");
    assert!(mine(r.data(), &["Zq Step"]).is_empty());
    r.step(3);
    assert_eq!(
        r.state().toolbar.as_ref().unwrap().range_label,
        civil_long(&r.state().anchor_day)
    );
    // The bar's month follows the anchor across a month.
    r.step(40);
    let month = r.state().toolbar.as_ref().unwrap().month_label.clone();
    assert_eq!(month, month_year(&r.state().anchor_day));

    // TODAY GOES BACK, and at today it is nothing.
    let before = r.driver.view(r.id).revision;
    r.send(H::Today(wire::agenda_home_event::TodayRequested {}));
    assert_eq!(r.state().anchor_day, r.today());
    assert_eq!(r.state().toolbar.as_ref().unwrap().range_label, "Today");
    let after = r.driver.view(r.id).revision;
    assert!(after > before);
    r.send(H::Today(wire::agenda_home_event::TodayRequested {}));
    assert_eq!(
        r.driver.view(r.id).revision,
        after,
        "at today it is nothing"
    );

    // Schedule's bar says "From …".
    let mut s = rig(Dest::Schedule);
    s.step(2);
    let long = civil_long(&s.day(2));
    assert_eq!(
        s.state().toolbar.as_ref().unwrap().range_label,
        format!("From {long}")
    );
}

fn civil_long(day: &str) -> String {
    let weekday = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ][civil::iso_weekday_of(day).unwrap() as usize - 1];
    format!(
        "{weekday} {} {}",
        civil::day_of_month_of(day).unwrap(),
        civil::month_of(Locale::En, day)
    )
}

fn month_year(day: &str) -> String {
    format!("{} {}", civil::month_of(Locale::En, day), &day[..4])
}

#[test]
fn to_do_has_no_day_bar_and_a_stray_step_is_nothing() {
    let mut r = rig(Dest::Todo);
    assert!(!r.state().toolbar.as_ref().unwrap().shown);
    let revision = r.driver.view(r.id).revision;
    r.step(1);
    r.send(H::Today(wire::agenda_home_event::TodayRequested {}));
    assert_eq!(r.driver.view(r.id).revision, revision);
    assert!(r.state().anchor_day.is_empty(), "To-do reads no window");
}

/// THE WINDOW IN ANY ZONE: `upcoming` takes instants, the window is padded a day
/// either side in UTC, and the fold cuts it by the days the core placed in the
/// device's zone. An event at 00:30 and one at 23:30 local belong to their local
/// day wherever the zone's midnight falls in UTC.
#[test]
fn the_window_is_right_in_any_zone() {
    for zone in [
        "Pacific/Kiritimati",
        "Pacific/Pago_Pago",
        "America/Los_Angeles",
        "Asia/Kolkata",
        "Europe/London",
    ] {
        let mut r = rig(Dest::Day);
        r.in_zone(zone);
        // The anchor is a civil day and stays; Today moves it to the zone's own.
        r.send(H::Today(wire::agenda_home_event::TodayRequested {}));
        let today = r.today();
        assert_eq!(r.state().anchor_day, today, "{zone}");
        let (soon, late) = (format!("{today}T00:30"), format!("{today}T23:30"));
        let before = format!("{}T23:30", civil::plus_days(&today, -1).unwrap());
        let after = format!("{}T00:30", civil::plus_days(&today, 1).unwrap());
        r.event("zq-soon", "Zq Soon", &soon, None);
        r.event("zq-late", "Zq Late", &late, None);
        r.event("zq-before", "Zq Before", &before, None);
        r.event("zq-after", "Zq After", &after, None);
        r.settle();
        let names = ["Zq Soon", "Zq Late", "Zq Before", "Zq After"];
        assert_eq!(
            mine(r.data(), &names),
            [format!("{today}: Zq Soon"), format!("{today}: Zq Late")],
            "{zone}"
        );
        // The neighbours hold theirs, and only theirs.
        r.step(1);
        assert_eq!(
            r.state().anchor_day,
            civil::plus_days(&today, 1).unwrap(),
            "{zone}"
        );
        assert_eq!(
            mine(r.data(), &names),
            [format!("{}: Zq After", r.state().anchor_day)],
            "{zone}"
        );
        r.step(-2);
        assert_eq!(
            mine(r.data(), &names),
            [format!("{}: Zq Before", r.state().anchor_day)],
            "{zone}"
        );
        // Schedule from today draws today and the day after, not the day before.
        r.step(1);
        r.band("schedule");
        assert_eq!(
            mine(r.data(), &names),
            [
                format!("{today}: Zq Soon"),
                format!("{today}: Zq Late"),
                format!("{}: Zq After", civil::plus_days(&today, 1).unwrap()),
            ],
            "{zone}"
        );
    }
}

#[test]
fn the_sections_run_in_day_order_with_the_month_named_where_the_list_reaches_a_new_one() {
    let mut r = rig(Dest::Schedule);
    let (a, b, c) = (r.day(2), r.day(3), r.day(40));
    r.event(
        "zq-a",
        "Zq Stand-up",
        &format!("{a}T10:00"),
        Some(&format!("{a}T10:15")),
    );
    r.event(
        "zq-b",
        "Zq Survey",
        &format!("{c}T08:15"),
        Some(&format!("{c}T09:45")),
    );
    r.event(
        "zq-c",
        "Zq Dentist",
        &format!("{b}T14:00"),
        Some(&format!("{b}T15:00")),
    );
    // THE PAD: a day before the window is in the answer and not drawn.
    r.event(
        "zq-y",
        "Zq Yesterday",
        &format!("{}T12:00", r.day(-1)),
        Some(&format!("{}T13:00", r.day(-1))),
    );
    r.settle();
    let names = ["Zq Stand-up", "Zq Survey", "Zq Dentist", "Zq Yesterday"];
    assert_eq!(
        mine(r.data(), &names),
        [
            format!("{a}: Zq Stand-up"),
            format!("{b}: Zq Dentist"),
            format!("{c}: Zq Survey")
        ]
    );
    let sec = section(r.data(), &c).unwrap();
    assert_eq!(sec.month_heading.as_deref(), Some(month_year(&c).as_str()));
    assert_eq!(
        sec.day_number,
        civil::day_of_month_of(&c).unwrap().to_string()
    );
    assert_eq!(sec.weekday_short, civil::weekday_short(Locale::En, &c));
    assert_eq!(sec.heading, civil::day_month(Locale::En, &c));
    assert!(section(r.data(), &a).unwrap().month_heading.is_none() || a[..7] != r.today()[..7]);
    assert!(
        !r.data().days.iter().any(|d| d.is_past),
        "Schedule draws no day before the anchor"
    );
    assert!(r.data().days.iter().filter(|d| d.is_today).count() <= 1);
    let count = r.data().event_count;
    assert_eq!(
        r.data().event_count_label,
        if count == 1 {
            "1 event".to_owned()
        } else {
            format!("{count} events")
        }
    );
    assert_eq!(r.data().empty, wire::AgendaEmpty::None as i32);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// A day's rows: all-day first, the now line before the first row that has not
/// started, ended rows dimmed. Run late in the minute before midnight and the
/// last row has started; nothing else here is clock-sensitive.
#[test]
fn todays_rows_all_day_first_the_now_line_among_what_has_not_started_ended_rows_dimmed() {
    let mut r = rig(Dest::Day);
    let today = r.today();
    r.event(
        "zq-early",
        "Zq Early",
        &format!("{today}T00:00"),
        Some(&format!("{today}T00:01")),
    );
    r.all_day("zq-bank", "Zq Bank holiday", &today, &today);
    r.event("zq-late", "Zq Late", &format!("{today}T23:59"), None);
    r.settle();
    let names = ["Zq Early", "Zq Bank holiday", "Zq Late"];
    let sec = section(r.data(), &today).unwrap();
    assert_eq!(
        titles(sec, &names),
        ["Zq Bank holiday", "Zq Early", "NOW", "Zq Late"]
    );
    let rows = events_of(sec);
    let past = |title: &str| rows.iter().find(|row| row.title == title).unwrap().is_past;
    assert!(past("Zq Early") && !past("Zq Bank holiday") && !past("Zq Late"));
    let now = sec
        .items
        .iter()
        .find_map(|item| match &item.kind {
            Some(wire::agenda_row_item::Kind::NowLine(line)) => Some(line.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(now.label, civil::clock(&r.data().now_local));
    assert_eq!(now.accessibility_label, format!("Now, {}", now.label));
    // OPENING LANDS AT NOW.
    assert!(r.data().landing.as_ref().unwrap().now_line);
    // The route a tap pushes names the occurrence and the day it was drawn under.
    let late = rows.iter().find(|row| row.title == "Zq Late").unwrap();
    assert_eq!(
        late.route,
        Some(agenda::routes::event(
            "zq-late",
            &late.instance_key,
            late.original_start_local.as_deref(),
            &today
        ))
    );
}

#[test]
fn a_time_is_a_range_a_start_all_day_until_from_or_continues() {
    let mut r = rig(Dest::Schedule);
    let (d0, d1, d2, d3, d4, d5) = (
        r.day(10),
        r.day(11),
        r.day(12),
        r.day(13),
        r.day(14),
        r.day(15),
    );
    r.event(
        "zq-range",
        "Zq Range",
        &format!("{d1}T08:15"),
        Some(&format!("{d1}T09:45")),
    );
    r.event("zq-instant", "Zq Instant", &format!("{d1}T08:15"), None);
    r.all_day("zq-all", "Zq Offsite", &d1, &d1);
    r.event(
        "zq-in",
        "Zq Red-eye",
        &format!("{d0}T22:00"),
        Some(&format!("{d1}T10:00")),
    );
    r.event(
        "zq-out",
        "Zq Night shift",
        &format!("{d1}T22:00"),
        Some(&format!("{d2}T02:00")),
    );
    r.event(
        "zq-run",
        "Zq Conference",
        &format!("{d3}T09:00"),
        Some(&format!("{d5}T17:00")),
    );
    r.event(
        "zq-mid",
        "Zq Late one",
        &format!("{d4}T23:00"),
        Some(&format!("{d5}T00:00")),
    );
    r.settle();
    let label = |day: &str, title: &str| {
        events_of(section(r.data(), day).unwrap_or_else(|| panic!("no section {day}")))
            .iter()
            .find(|row| row.title == title)
            .unwrap_or_else(|| panic!("no {title} on {day}"))
            .time_label
            .clone()
    };
    assert_eq!(label(&d1, "Zq Red-eye"), "Until 10:00");
    assert_eq!(label(&d0, "Zq Red-eye"), "From 22:00");
    assert_eq!(label(&d1, "Zq Offsite"), "All day");
    assert_eq!(label(&d1, "Zq Instant"), "08:15");
    assert_eq!(label(&d1, "Zq Range"), "08:15 – 09:45");
    assert_eq!(label(&d1, "Zq Night shift"), "From 22:00");
    assert_eq!(label(&d2, "Zq Night shift"), "Until 02:00");
    assert_eq!(label(&d3, "Zq Conference"), "From 09:00");
    assert_eq!(label(&d4, "Zq Conference"), "Continues");
    assert_eq!(label(&d5, "Zq Conference"), "Until 17:00");
    // AN END AT THE NEXT MIDNIGHT IS EXCLUSIVE: it ends on its own day.
    assert_eq!(label(&d4, "Zq Late one"), "23:00 – 00:00");
    // A run over three days is a row on each, keyed apart, and counted once.
    let keys: Vec<String> = [&d3, &d4, &d5]
        .iter()
        .map(|day| {
            events_of(section(r.data(), day).unwrap())
                .iter()
                .find(|row| row.title == "Zq Conference")
                .unwrap()
                .row_key
                .clone()
        })
        .collect();
    assert_eq!(keys.len(), 3);
    assert_eq!(
        keys.iter().collect::<std::collections::BTreeSet<_>>().len(),
        3
    );
    assert!(keys[0].starts_with(&format!("{d3}|")));
    // All-day rows sort before timed ones.
    let first = titles(
        section(r.data(), &d1).unwrap(),
        &["Zq Offsite", "Zq Range", "Zq Instant", "Zq Red-eye"],
    );
    assert_eq!(first[0], "Zq Offsite");
}

#[test]
fn every_occurrence_of_a_series_says_repeats_and_the_label_speaks_the_rest() {
    let mut r = rig(Dest::Schedule);
    let (me, other) = r.people();
    let day = r.day(3);
    r.write(act::agenda::Propose {
        id: Some("zq-series".to_owned()),
        title: "Zq Survey".to_owned(),
        starts: format!("{day}T08:15"),
        ends: Field::Is(format!("{day}T09:45")),
        zone: Field::Is("UTC".to_owned()),
        rule: Field::Is("FREQ=WEEKLY".to_owned()),
        url: Field::Is("https://meet.example/abc".to_owned()),
        attendees: Some(serde_json_array(&[&me, &other])),
        busy: Some(false),
        ..Default::default()
    });
    r.settle();
    let sec = section(r.data(), &day).unwrap();
    let row = events_of(sec)
        .into_iter()
        .find(|row| row.title == "Zq Survey")
        .unwrap();
    assert_eq!(row.meta, "repeats · 1 guest · call");
    assert_eq!(row.status, wire::AgendaRowStatus::NeedsReply as i32);
    assert_eq!(row.status_label, "needs a reply");
    assert_eq!(
        row.accessibility_label,
        "Zq Survey, 08:15 to 09:45, repeats, 1 guest, call, needs a reply"
    );
    // EVERY occurrence, the later weeks too.
    let later = section(r.data(), &r.day(10)).unwrap();
    assert_eq!(
        events_of(later)
            .into_iter()
            .find(|row| row.title == "Zq Survey")
            .unwrap()
            .meta,
        "repeats · 1 guest · call"
    );
}

fn serde_json_array(ids: &[&str]) -> String {
    serde_json::to_string(ids).unwrap()
}

#[test]
fn waiting_is_your_unanswered_invitations_and_a_birthday_does_not_make_a_day() {
    let mut r = rig(Dest::Waiting);
    // Nothing waits in the scenario.
    assert_eq!(r.data().empty, wire::AgendaEmpty::NothingWaiting as i32);
    assert_eq!(r.data().empty_title, "Nothing is waiting on you.");
    assert!(r.data().days.is_empty());

    let (me, other) = r.people();
    let day = r.day(2);
    r.write(act::agenda::Propose {
        id: Some("zq-ask".to_owned()),
        title: "Zq Offsite".to_owned(),
        starts: format!("{day}T09:00"),
        zone: Field::Is("UTC".to_owned()),
        attendees: Some(serde_json_array(&[&me, &other])),
        busy: Some(false),
        ..Default::default()
    });
    r.event("zq-mine", "Zq Gym", &format!("{day}T18:00"), None);
    r.settle();
    let data = r.data();
    assert_eq!(data.waiting_count, 1);
    // ONLY THE OCCURRENCES WAITING ON YOU.
    assert_eq!(
        mine(data, &["Zq Offsite", "Zq Gym"]),
        [format!("{day}: Zq Offsite")]
    );
    assert_eq!(
        data.days.len(),
        1,
        "a birthday or a task makes no Waiting day"
    );
    // Schedule shows both; moving between them keeps the window.
    r.band("schedule");
    assert_eq!(
        mine(r.data(), &["Zq Offsite", "Zq Gym"]),
        [format!("{day}: Zq Offsite"), format!("{day}: Zq Gym")]
    );
    assert_eq!(r.data().waiting_count, 1);
    r.band("waiting");
    assert_eq!(
        r.state()
            .band
            .iter()
            .filter(|t| t.current)
            .map(|t| t.key.as_str())
            .collect::<Vec<_>>(),
        ["waiting"]
    );
}

#[test]
fn a_hidden_calendar_re_folds_and_says_so_in_the_sheet_and_hides_no_task() {
    let mut r = rig(Dest::Schedule);
    let day = r.day(2);
    r.event("zq-cal", "Zq Personal thing", &format!("{day}T09:00"), None);
    r.task("zq-cal-task", "Zq Due thing", Some(&day));
    r.settle();
    assert_eq!(
        mine(r.data(), &["Zq Personal thing", "Zq Due thing"]).len(),
        2
    );
    let calendar = r.data().calendars[0].clone();
    assert!(!calendar.hidden && calendar.state_label == "Shown");
    assert!(calendar.hue_key.starts_with('c'));
    let before = r.driver.view(r.id).revision;
    r.send(H::CalendarToggled(
        wire::agenda_home_event::CalendarToggled {
            calendar_id: calendar.calendar_id.clone(),
        },
    ));
    assert!(r.driver.view(r.id).revision > before);
    assert_eq!(
        r.state().hidden_calendar_ids,
        std::slice::from_ref(&calendar.calendar_id)
    );
    // THE EVENT GOES, THE TASK STAYS.
    assert_eq!(
        mine(r.data(), &["Zq Personal thing", "Zq Due thing"]),
        [format!("{day}: Zq Due thing")]
    );
    let choice = r.data().calendars[0].clone();
    assert!(choice.hidden);
    assert_eq!(choice.state_label, "Hidden");
    // EVERYTHING HIDDEN IS NOT DAY ONE.
    assert_ne!(r.data().empty, wire::AgendaEmpty::DayOne as i32);
    // Toggled back.
    r.send(H::CalendarToggled(
        wire::agenda_home_event::CalendarToggled {
            calendar_id: calendar.calendar_id,
        },
    ));
    assert!(r.state().hidden_calendar_ids.is_empty());
    assert_eq!(mine(r.data(), &["Zq Personal thing"]).len(), 1);
}

#[test]
fn a_birthday_is_a_ribbon_on_the_day_and_never_a_row() {
    let r = rig(Dest::Schedule);
    let ribbon = r
        .data()
        .days
        .iter()
        .find(|day| day.ribbon.is_some())
        .expect("the scenario has a birthday");
    assert!(
        ribbon
            .ribbon
            .as_deref()
            .is_some_and(|name| !name.is_empty())
    );
    assert_eq!(ribbon.ribbon_names.len(), 1);
    assert_eq!(
        ribbon.ribbon.as_deref(),
        Some(ribbon.ribbon_names[0].as_str())
    );
    assert!(
        events_of(ribbon)
            .iter()
            .all(|row| row.title != ribbon.ribbon_names[0])
    );
}

// ---------------------------------------------------------------------------
// The More sheet
// ---------------------------------------------------------------------------

#[test]
fn more_is_rows_on_the_state_and_a_rows_key_does_the_rest() {
    let mut r = rig(Dest::Schedule);
    r.band("more");
    assert_eq!(r.state().sheet, Sheet::More as i32);
    assert!(
        r.state()
            .band
            .iter()
            .find(|tab| tab.key == "more")
            .unwrap()
            .current
    );
    let rows = r.state().more_rows.clone();
    let cal_key = format!("calendar-{}", r.data().calendars[0].calendar_id);
    assert_eq!(
        rows.iter().map(|row| row.key.as_str()).collect::<Vec<_>>(),
        [
            cal_key.as_str(),
            "anytime",
            "logbook",
            "reminders",
            "trash",
            "reads"
        ]
    );
    assert_eq!(
        rows[1..]
            .iter()
            .map(|row| row.label.as_str())
            .collect::<Vec<_>>(),
        [
            "Anytime",
            "Logbook",
            "Reminders",
            "Trash",
            "What Agenda may read"
        ]
    );
    // THE HEADINGS RIDE ON THE FIRST ROW OF EACH GROUP, and only there (R-1128-6).
    assert_eq!(
        rows.iter()
            .map(|row| row.section.as_str())
            .collect::<Vec<_>>(),
        ["Calendars", "Tasks", "", "", "", ""]
    );
    assert_eq!(
        rows.iter().map(|row| row.toggle).collect::<Vec<_>>(),
        [true, false, false, false, false, false]
    );
    assert!(
        rows[0].on
            && rows[0].meta == "Shown"
            && rows[0].spoken == format!("{}, Shown", rows[0].label)
    );
    assert!(
        rows.iter()
            .all(|row| row.label != "Search" && row.key != "search")
    );
    assert_eq!(
        rows[1..5]
            .iter()
            .map(|row| row.icon_key.as_str())
            .collect::<Vec<_>>(),
        ["Layers", "Book", "Bell", "Trash"]
    );
    // WHERE A TASKS PLACE GOES is the row's own route.
    assert_eq!(
        rows[1].route,
        Some(agenda::routes::todo_list(wire::TodoView::Anytime))
    );
    assert_eq!(
        rows[2].route,
        Some(agenda::routes::todo_list(wire::TodoView::Logbook))
    );
    assert_eq!(
        rows[3].route,
        Some(agenda::routes::todo_list(wire::TodoView::Reminders))
    );
    assert_eq!(rows[4].route, Some(agenda::routes::trash()));
    assert!(rows[0].route.is_none() && rows[5].route.is_none());

    // A CALENDAR ROW TOGGLES; the sheet stays up.
    r.more_row(&cal_key);
    assert_eq!(r.state().hidden_calendar_ids.len(), 1);
    assert_eq!(r.state().sheet, Sheet::More as i32);
    let hidden = r.state().more_rows[0].clone();
    assert!(!hidden.on);
    assert_eq!(hidden.meta, "Hidden");
    assert_eq!(hidden.spoken, format!("{}, Hidden", hidden.label));

    // THE READS ROW opens the facts sheet; a key the sheet does not hold does nothing.
    r.more_row("calendar-gone");
    assert_eq!(r.state().sheet, Sheet::More as i32);
    assert_eq!(r.state().hidden_calendar_ids.len(), 1);
    r.more_row("reads");
    assert_eq!(r.state().sheet, Sheet::Reads as i32);
    assert_eq!(
        r.state()
            .chrome
            .as_ref()
            .unwrap()
            .reads_facts
            .iter()
            .map(|fact| fact.label.as_str())
            .collect::<Vec<_>>(),
        ["Reads", "Writes", "Leaves this phone"]
    );
    // A TASKS PLACE closes the sheet; the shell pushes its route.
    r.band("more");
    r.more_row("logbook");
    assert_eq!(r.state().sheet, Sheet::None as i32);
    // The sheet closes by its own event too.
    r.band("more");
    r.send(H::SheetClosed(wire::agenda_home_event::SheetClosed {}));
    assert_eq!(r.state().sheet, Sheet::None as i32);
}

#[test]
fn to_do_has_no_calendar_rows_in_more() {
    let mut r = rig(Dest::Todo);
    r.band("more");
    assert_eq!(
        r.state()
            .more_rows
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>(),
        ["anytime", "logbook", "reminders", "trash", "reads"]
    );
    assert_eq!(r.state().more_rows[0].section, "Tasks");
    assert!(
        r.state()
            .more_rows
            .iter()
            .all(|row| row.icon_key != "Search" && row.key != "all" && row.key != "catch_up")
    );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[test]
fn search_opening_reads_nothing_a_term_finds_over_the_rows_and_closing_clears_it() {
    let mut r = rig(Dest::Schedule);
    let past = r.day(-60);
    r.event(
        "zq-hit",
        "Zq Dentist visit",
        &format!("{past}T14:00"),
        Some(&format!("{past}T15:00")),
    );
    r.settle();
    let held = r.data().days.len();
    r.open_search();
    assert!(r.state().search_open);
    // SEARCH IS A MODE OVER THE PLACE: the place's tab stays lit.
    assert_eq!(
        r.state()
            .band
            .iter()
            .filter(|t| t.current)
            .map(|t| t.key.as_str())
            .collect::<Vec<_>>(),
        ["schedule"]
    );
    assert_eq!(r.data().days.len(), held);
    // A BAND KEY THAT IS NO LONGER A TAB opens nothing.
    r.band("search");
    assert!(r.state().search_open);

    r.term("zq dentist");
    // A HIT LAST MONTH IS STILL THE ANSWER, dimmed as past, with its month.
    let sec = section(r.data(), &past).expect("the hit's day");
    assert!(sec.is_past);
    assert!(sec.month_heading.is_some());
    assert_eq!(events_of(sec)[0].title, "Zq Dentist visit");
    assert!(
        !r.state().toolbar.as_ref().unwrap().shown,
        "search results are not a window"
    );
    // ASK is the row at the foot of an answer, scoped to Agenda.
    let ask = r.state().search_ask_row.clone().unwrap();
    assert_eq!(ask.label, "Ask about “zq dentist”");
    assert_eq!(ask.question, "Find zq dentist");
    assert_eq!(ask.scope, "agenda");

    r.close_search();
    assert!(!r.state().search_open);
    assert_eq!(r.state().search_term, "");
    assert!(r.state().search_ask_row.is_none());
    assert!(section(r.data(), &past).is_none());
    assert!(r.state().toolbar.as_ref().unwrap().shown);
}

#[test]
fn search_with_nothing_found_says_so_and_still_offers_ask() {
    let mut r = rig(Dest::Schedule);
    r.open_search();
    r.term("zzqxj");
    assert_eq!(r.data().empty, wire::AgendaEmpty::NoMatch as i32);
    assert_eq!(r.data().empty_title, "Nothing matches that.");
    assert_eq!(r.data().empty_body, "Try fewer words, or a different day.");
    assert_eq!(r.data().empty_action, "");
    let ask = r.state().search_ask_row.clone().unwrap();
    assert_eq!(
        (
            ask.label.as_str(),
            ask.question.as_str(),
            ask.scope.as_str()
        ),
        ("Ask about “zzqxj”", "Find zzqxj", "agenda")
    );
    // A NEW TERM clears the ask until its own answer lands, here at once.
    r.term("zzq");
    assert_eq!(
        r.state().search_ask_row.clone().unwrap().label,
        "Ask about “zzq”"
    );
    // Clearing the term goes back to the window's own list.
    r.term("");
    assert!(r.state().search_ask_row.is_none());
    assert_ne!(r.data().empty, wire::AgendaEmpty::NoMatch as i32);
    assert!(r.state().search_open, "the field stays open");
}

#[test]
fn search_names_the_words_the_core_corrected_and_a_new_term_or_a_close_clears_them() {
    let mut r = rig(Dest::Schedule);
    r.open_search();
    r.term("dentsit");
    assert_eq!(
        r.state().search_corrected,
        "Including results for “dentist”"
    );
    r.term("dentist");
    assert_eq!(
        r.state().search_corrected,
        "",
        "an exact answer says nothing was corrected"
    );
    r.term("dentsit");
    r.close_search();
    assert_eq!(r.state().search_corrected, "");
}

#[test]
fn search_from_waiting_covers_every_event_not_only_the_ones_waiting_on_you() {
    let mut r = rig(Dest::Waiting);
    let (me, other) = r.people();
    let day = r.day(2);
    r.write(act::agenda::Propose {
        id: Some("zq-w".to_owned()),
        title: "Zq Offsite".to_owned(),
        starts: format!("{day}T09:00"),
        zone: Field::Is("UTC".to_owned()),
        attendees: Some(serde_json_array(&[&me, &other])),
        busy: Some(false),
        ..Default::default()
    });
    r.event("zq-g", "Zq Gym", &format!("{day}T18:00"), None);
    r.settle();
    assert_eq!(
        mine(r.data(), &["Zq Offsite", "Zq Gym"]),
        [format!("{day}: Zq Offsite")]
    );
    r.open_search();
    r.term("zq gym");
    assert_eq!(r.state().destination, Dest::Waiting as i32);
    assert_eq!(
        mine(r.data(), &["Zq Offsite", "Zq Gym"]),
        [format!("{day}: Zq Gym")]
    );
    assert_eq!(r.data().empty, wire::AgendaEmpty::None as i32);
    // Picking a destination leaves search, even the lit tab.
    r.band("waiting");
    assert!(!r.state().search_open);
    assert_eq!(r.state().search_term, "");
}

#[test]
fn search_finds_tasks_as_well_as_events_a_group_above_the_days() {
    let mut r = rig(Dest::Schedule);
    let day = r.day(5);
    r.task("zq-t", "Zq Book podiatrist", Some(&day));
    r.event("zq-e", "Zq Podiatrist visit", &format!("{day}T09:00"), None);
    r.settle();
    r.open_search();
    r.term("zq podiatrist");
    let data = r.data();
    let group = data.task_hits.first().expect("the tasks group");
    assert_eq!(group.title, "Tasks");
    assert_eq!(group.meta, "1");
    assert_eq!(group.rows[0].title, "Zq Book podiatrist");
    assert_eq!(group.rows[0].route, Some(agenda::routes::task("zq-t")));
    assert_eq!(
        mine(data, &["Zq Podiatrist visit"]),
        [format!("{day}: Zq Podiatrist visit")]
    );
    // TASKS ALONE ARE AN ANSWER: no "nothing matches" over them.
    r.term("zq book podiatrist");
    assert_eq!(r.data().empty, wire::AgendaEmpty::None as i32);
    assert_eq!(r.data().task_hits[0].rows.len(), 1);
    // A task hit is checked off in place: its box shows it done, and Undo is on the status line.
    r.check("zq-t");
    assert_eq!(r.status().unwrap().sentence, "Task done");
    assert_eq!(
        r.data().task_hits[0].rows[0].check,
        wire::TodoCheck::Done as i32
    );
    r.send(H::StatusActed(wire::agenda_home_event::StatusActed {}));
    assert_eq!(
        r.data().task_hits[0].rows[0].check,
        wire::TodoCheck::Open as i32
    );
    // Closing search clears the hits and re-folds the window.
    r.close_search();
    assert!(r.data().task_hits.is_empty());
}

#[test]
fn a_tasks_search_that_corrected_its_words_names_them() {
    let mut r = rig(Dest::Day);
    r.task("zq-p", "Zq Book dentist", None);
    r.settle();
    r.open_search();
    r.term("zq book dentst");
    assert!(
        r.state()
            .search_corrected
            .starts_with("Including results for “"),
        "{}",
        r.state().search_corrected
    );
    r.term("zq");
    assert_eq!(r.state().search_corrected, "");
}

#[test]
fn search_finds_a_project_by_name_and_a_tap_opens_its_page() {
    let mut r = rig(Dest::Schedule);
    r.write(act::agenda::CreateProject {
        kind: act::agenda::CreateProjectKind::Project,
        title: "Zqgarden".to_owned(),
        id: Some("zq-garden".to_owned()),
        ..Default::default()
    });
    r.task("zq-w", "Water the zqgarden", None);
    r.settle();
    r.open_search();
    r.term("zqgarden");
    let data = r.data();
    let container = data.containers.first().expect("the project");
    assert_eq!(container.entity, "project");
    assert_eq!(container.id, "zq-garden");
    assert_eq!(container.title, "Zqgarden");
    assert_eq!(container.kind_label, "Project");
    assert_eq!(container.icon_key, "List");
    assert_eq!(container.accessibility_label, "Project, Zqgarden");
    assert_eq!(
        container.route,
        Some(agenda::routes::project("zq-garden", "Zqgarden"))
    );
    assert_eq!(data.task_hits[0].rows[0].title, "Water the zqgarden");
    assert_eq!(data.empty, wire::AgendaEmpty::None as i32);

    // ONLY A PROJECT MATCHED: no "nothing matches" sentence, and Ask still at the foot.
    r.task("zq-other", "Zq Unrelated", None);
    r.act(act::agenda::DeleteTask {
        task_id: "zq-w".to_owned(),
    });
    r.settle();
    r.term("zqgardens");
    assert!(r.state().search_ask_row.is_some());
    // A new term's answer replaces them; closing clears them.
    r.term("zq unrelated");
    assert!(r.data().containers.is_empty());
    r.term("zqgarden");
    r.close_search();
    assert!(r.data().containers.is_empty());
}

#[test]
fn to_dos_search_draws_the_containers_too() {
    let mut r = rig(Dest::Todo);
    r.write(act::agenda::CreateProject {
        kind: act::agenda::CreateProjectKind::Project,
        title: "Zqorchard".to_owned(),
        id: Some("zq-orchard".to_owned()),
        ..Default::default()
    });
    r.settle();
    r.open_search();
    r.term("zqorchard");
    assert_eq!(r.state().destination, Dest::Todo as i32);
    assert_eq!(r.data().containers[0].id, "zq-orchard");
    assert_eq!(r.data().empty, wire::AgendaEmpty::None as i32);
    assert!(r.data().todo.is_none(), "a search is the events' fold");
    r.close_search();
    assert!(r.data().todo.is_some());
}

// ---------------------------------------------------------------------------
// Empties, failure, change
// ---------------------------------------------------------------------------

#[test]
fn the_empties_are_four_different_screens() {
    // DAY ONE: Schedule's whole window empty, nothing hidden, no search. A window
    // past every birthday, so no ribbon makes a day of it.
    let mut r = rig(Dest::Schedule);
    r.clear();
    for _ in 0..12 {
        if r.data().days.is_empty() {
            break;
        }
        r.step(30);
    }
    assert!(
        r.data().days.is_empty(),
        "a window with no birthday exists within a year"
    );
    let data = r.data();
    assert_eq!(data.empty, wire::AgendaEmpty::DayOne as i32);
    assert_eq!(data.empty_title, "Nothing in your calendar yet.");
    assert_eq!(data.empty_body, "The first event is one field and a time.");
    assert_eq!(data.empty_action, "New event");
    assert_eq!(data.import_source, wire::ImportSource::Calendar as i32);
    // The action pushes the add sheet, on the anchor day.
    let add = r.state().new_event.clone().unwrap();
    assert_eq!(
        add,
        agenda::routes::editor(
            "",
            "",
            None,
            &r.state().anchor_day,
            wire::AgendaEditorKind::Unspecified
        )
    );
    // EVERYTHING HIDDEN IS NOT DAY ONE: the calendar is not empty.
    let anchor = r.state().anchor_day.clone();
    r.event(
        "zq-one",
        "Zq One",
        &format!("{}T09:00", civil::plus_days(&anchor, 2).unwrap()),
        None,
    );
    r.settle();
    let id = r.data().calendars[0].calendar_id.clone();
    r.send(H::CalendarToggled(
        wire::agenda_home_event::CalendarToggled { calendar_id: id },
    ));
    assert_eq!(r.data().empty, wire::AgendaEmpty::NothingOnDay as i32);
    assert_eq!(r.data().empty_title, "Nothing on these days.");
    assert_eq!(
        r.data().import_source,
        wire::ImportSource::Unspecified as i32
    );

    let mut d = rig(Dest::Day);
    d.clear();
    assert_eq!(d.data().empty, wire::AgendaEmpty::NothingOnDay as i32);
    assert_eq!(d.data().empty_title, "Nothing on this day.");
    assert_eq!(d.data().empty_action, "");
    assert_eq!(d.data().import_source, wire::ImportSource::Calendar as i32);
}

#[test]
fn a_failed_read_is_a_failure_and_never_an_empty_agenda_and_refreshed_is_its_retry() {
    let mut r = rig(Dest::Day);
    r.in_zone("Not/AZone");
    let failure = match &r.state().content {
        Some(Content::Failure(failure)) => failure.clone(),
        other => panic!("expected a failure, found {other:?}"),
    };
    assert_eq!(failure.sentence, "Couldn't read this. Try again.");
    assert_eq!(failure.remedy, "Try again");
    assert_eq!(r.state().chrome.as_ref().unwrap().retry, "Try again");
    // The band stands and the data is not an empty list.
    assert_eq!(r.state().band.len(), 5);
    r.in_zone("Europe/London");
    assert!(matches!(r.state().content, Some(Content::Data(_))));
    r.in_zone("Not/AZone");
    assert!(matches!(r.state().content, Some(Content::Failure(_))));
    r.zone = "UTC".to_owned();
    r.driver
        .call(wire::screen_request::Kind::Environment(wire::Environment {
            locale: "en".to_owned(),
            zone: "UTC".to_owned(),
            ..Default::default()
        }));
    r.send(H::Refreshed(wire::agenda_home_event::Refreshed {}));
    assert!(matches!(r.state().content, Some(Content::Data(_))));
}

#[test]
fn a_write_by_someone_else_redraws_the_screen_once() {
    let mut r = rig(Dest::Schedule);
    let day = r.day(4);
    let before = r.driver.view(r.id).revision;
    r.event("zq-live", "Zq Live", &format!("{day}T09:00"), None);
    let arrived = r.driver.pump(Duration::from_millis(500));
    assert!(arrived >= 1, "the change was pushed to the shell");
    assert_eq!(mine(r.data(), &["Zq Live"]), [format!("{day}: Zq Live")]);
    assert!(r.driver.view(r.id).revision > before);
    // A task due the same day also arrives (the dated boards are read again).
    r.task("zq-live-task", "Zq Live task", Some(&day));
    r.driver.pump(Duration::from_millis(500));
    assert_eq!(
        mine(r.data(), &["Zq Live task"]),
        [format!("{day}: Zq Live task")]
    );
}

// ---------------------------------------------------------------------------
// Tasks on their days
// ---------------------------------------------------------------------------

#[test]
fn a_task_due_today_is_a_row_of_today_untimed_after_the_all_day_rows_timed_among_the_timed() {
    let mut r = rig(Dest::Day);
    let today = r.today();
    r.event(
        "zq-run",
        "Zq Run",
        &format!("{today}T00:00"),
        Some(&format!("{today}T00:01")),
    );
    r.all_day("zq-bank", "Zq Bank holiday", &today, &today);
    r.task("zq-untimed", "Zq Buy milk", Some(&today));
    r.task("zq-rent", "Zq Pay rent", Some(&format!("{today}T00:00")));
    r.task("zq-notes", "Zq Send notes", Some(&format!("{today}T23:59")));
    r.settle();
    let names = [
        "Zq Run",
        "Zq Bank holiday",
        "Zq Buy milk",
        "Zq Pay rent",
        "Zq Send notes",
    ];
    let sec = section(r.data(), &today).unwrap();
    assert_eq!(
        titles(sec, &names),
        [
            "Zq Bank holiday",
            "Zq Buy milk",
            "Zq Run",
            "Zq Pay rent",
            "NOW",
            "Zq Send notes"
        ]
    );
    // A TASK AT THE SAME MINUTE sorts after the event (the sort is stable, events first).
    // THE ONE ROW SHAPE: the box says what it does, and the head names the day, so a row says its time only.
    let rows = tasks_of(sec);
    let row = |title: &str| rows.iter().find(|row| row.title == title).unwrap();
    assert_eq!(row("Zq Buy milk").due_label, "");
    assert_eq!(row("Zq Pay rent").due_label, "00:00");
    assert_eq!(row("Zq Send notes").due_label, "23:59");
    assert_eq!(row("Zq Buy milk").check, wire::TodoCheck::Open as i32);
    assert_eq!(row("Zq Buy milk").check_label, "Mark Zq Buy milk done");
    assert_eq!(
        row("Zq Buy milk").route,
        Some(agenda::routes::task("zq-untimed"))
    );
    // The events' count is the events' alone.
    let events = r.data().event_count;
    assert!(r.data().days.iter().flat_map(events_of).count() as u32 >= events);
}

#[test]
fn schedule_gives_a_day_of_only_tasks_its_own_section_and_waiting_draws_none() {
    let mut r = rig(Dest::Schedule);
    let (a, b) = (r.day(61), r.day(75));
    r.task("zq-b", "Zq Bins", Some(&a));
    r.task("zq-c", "Zq Invoice", Some(&b));
    r.settle();
    assert_eq!(
        mine(r.data(), &["Zq Bins", "Zq Invoice"]),
        [format!("{a}: Zq Bins"), format!("{b}: Zq Invoice")]
    );
    // WAITING DRAWS NO TASK, and makes no day of one.
    r.band("waiting");
    assert!(mine(r.data(), &["Zq Bins", "Zq Invoice"]).is_empty());
    assert!(section(r.data(), &a).is_none());
    // Back on Schedule the tasks draw again.
    r.band("schedule");
    assert_eq!(mine(r.data(), &["Zq Bins", "Zq Invoice"]).len(), 2);
}

#[test]
fn an_empty_day_counts_its_tasks_a_day_with_only_a_task_is_not_nothing() {
    let mut r = rig(Dest::Day);
    r.clear();
    assert_eq!(r.data().empty, wire::AgendaEmpty::NothingOnDay as i32);
    r.task("zq-only", "Zq Buy milk", Some(&r.today()));
    r.settle();
    assert_eq!(r.data().empty, wire::AgendaEmpty::None as i32);
    assert_eq!(
        tasks_of(section(r.data(), &r.today()).unwrap())[0].title,
        "Zq Buy milk"
    );
    // A box checks it off in place: gone at once, and the sentence is right again.
    r.check("zq-only");
    assert_eq!(r.data().empty, wire::AgendaEmpty::NothingOnDay as i32);
}

#[test]
fn day_on_today_draws_the_overdue_group_with_its_verb_and_the_notice_an_absence_names() {
    let mut r = rig(Dest::Day);
    r.clear();
    r.task("zq-old", "Zq Pay rent", Some(&r.day(-16)));
    r.task("zq-b", "Zq Call Ana", Some(&format!("{}T09:00", r.today())));
    r.settle();
    let data = r.data();
    let overdue = data.overdue.as_ref().expect("the Overdue group");
    assert_eq!(overdue.title, "Overdue");
    assert_eq!(overdue.verb_label, "Reschedule");
    assert_eq!(overdue.verb_key, "catch_up");
    assert_eq!(overdue.meta, "1");
    assert_eq!(overdue.rows[0].due_label, "16 days ago");
    assert!(overdue.rows[0].overdue);
    let notice = data.notice.as_ref().expect("the absence notice");
    assert_eq!(notice.sentence, "You were away 16 days · 1 task came due");
    assert_eq!(notice.verb_label, "Reschedule");
    assert_eq!(notice.verb_key, "catch_up");
    // BOTH VERBS OPEN CATCH UP.
    assert_eq!(data.catch_up, Some(agenda::routes::catch_up()));
    // The overdue work is above the day and not in it: today's section holds today's task alone.
    let ids: Vec<&str> = tasks_of(section(data, &r.today()).unwrap())
        .iter()
        .map(|t| t.task_id.as_str())
        .collect();
    assert_eq!(ids, ["zq-b"]);
    // More than one: the plural.
    r.task("zq-old2", "Zq Water bill", Some(&r.day(-9)));
    r.settle();
    assert_eq!(
        r.data().notice.as_ref().unwrap().sentence,
        "You were away 16 days · 2 tasks came due"
    );

    // ANOTHER ANCHOR: none of it.
    r.step(1);
    assert!(r.data().overdue.is_none() && r.data().notice.is_none());
    // SCHEDULE draws neither: the Overdue head is Day's.
    r.band("schedule");
    r.step(-1);
    assert!(r.data().overdue.is_none() && r.data().notice.is_none());
}

#[test]
fn day_says_nothing_is_on_it_only_when_nothing_is_overdue_alone_is_something() {
    let mut r = rig(Dest::Day);
    r.clear();
    r.task("zq-owed", "Zq Pay rent", Some(&r.day(-2)));
    r.settle();
    let data = r.data();
    assert!(data.days.is_empty());
    assert!(data.overdue.is_some());
    assert_eq!(data.empty, wire::AgendaEmpty::None as i32);
    assert_eq!(data.empty_title, "");
    // NO ABSENCE under a week: no notice.
    assert!(data.notice.is_none());
}

#[test]
fn a_past_day_draws_the_open_tasks_that_came_due_on_it_as_rows_of_it() {
    let mut r = rig(Dest::Day);
    r.task("zq-past", "Zq Pay rent", Some(&r.day(-1)));
    r.settle();
    r.step(-1);
    let data = r.data();
    // NO OVERDUE GROUP ON A PAST DAY: the work is in its own day.
    assert!(data.overdue.is_none());
    assert_eq!(
        tasks_of(section(data, &r.state().anchor_day).unwrap())[0].title,
        "Zq Pay rent"
    );
    assert!(section(data, &r.state().anchor_day).unwrap().is_past);
}

#[test]
fn a_box_checks_a_task_off_in_place_and_undo_is_the_inverse() {
    let mut r = rig(Dest::Day);
    r.task("zq-a", "Zq Call Ana", Some(&r.today()));
    r.settle();
    let revision = r.driver.view(r.id).revision;
    r.check("zq-a");
    assert!(r.driver.view(r.id).revision > revision);
    // IN PLACE: gone at once.
    assert!(mine(r.data(), &["Zq Call Ana"]).is_empty());
    let status = r.status().unwrap();
    assert_eq!(status.sentence, "Task done");
    assert_eq!(status.action_label, "Undo");
    assert!(!status.refused);
    // Undo reopens it, and the status line goes.
    r.send(H::StatusActed(wire::agenda_home_event::StatusActed {}));
    assert_eq!(
        mine(r.data(), &["Zq Call Ana"]),
        [format!("{}: Zq Call Ana", r.today())]
    );
    assert!(r.status().is_none());
    // Checking it again is not a replay of the first.
    r.check("zq-a");
    assert!(mine(r.data(), &["Zq Call Ana"]).is_empty());
    assert_eq!(r.status().unwrap().sentence, "Task done");
    // A task that is not on screen is not checked.
    let revision = r.driver.view(r.id).revision;
    r.check("zq-gone");
    assert_eq!(r.driver.view(r.id).revision, revision);
}

#[test]
fn an_overdue_row_is_checked_off_in_place_too() {
    let mut r = rig(Dest::Day);
    r.clear();
    r.task("zq-o", "Zq Pay rent", Some(&r.day(-2)));
    r.settle();
    assert!(r.data().overdue.is_some());
    r.check("zq-o");
    assert!(r.data().overdue.is_none());
}

// ---------------------------------------------------------------------------
// To-do
// ---------------------------------------------------------------------------

fn inbox_titles(r: &Rig) -> Vec<String> {
    r.todo()
        .groups
        .iter()
        .filter(|group| group.title == "Inbox")
        .flat_map(|group| group.rows.iter().map(|row| row.title.clone()))
        .collect()
}

#[test]
fn the_inbox_then_the_projects_by_area_named_areas_a_to_z_then_projects_for_those_in_none() {
    let mut r = rig(Dest::Todo);
    r.clear();
    r.write(act::agenda::CreateProject {
        kind: act::agenda::CreateProjectKind::Area,
        title: "Work".to_owned(),
        id: Some("zq-area-work".to_owned()),
        ..Default::default()
    });
    r.write(act::agenda::CreateProject {
        kind: act::agenda::CreateProjectKind::Area,
        title: "Home".to_owned(),
        id: Some("zq-area-home".to_owned()),
        ..Default::default()
    });
    for (id, title, area) in [
        ("zq-garden", "Garden", Some("zq-area-home")),
        ("zq-taxes", "Taxes", None),
        ("zq-launch", "Launch", Some("zq-area-work")),
    ] {
        r.write(act::agenda::CreateProject {
            kind: act::agenda::CreateProjectKind::Project,
            title: title.to_owned(),
            id: Some(id.to_owned()),
            parent: area.map_or(Field::Keep, |area| Field::Is(area.to_owned())),
            ..Default::default()
        });
    }
    r.task("zq-idea", "Idea", None);
    r.task("zq-seeds", "Seeds", None);
    r.write(act::agenda::OrganizeTask {
        task_id: "zq-seeds".to_owned(),
        project_id: Field::Is("zq-garden".to_owned()),
        ..Default::default()
    });
    r.settle();
    let todo = r.todo();
    assert_eq!(inbox_titles(&r), ["Idea"]);
    let groups: Vec<(&str, Vec<&str>)> = todo
        .projects
        .iter()
        .map(|group| {
            (
                group.title.as_str(),
                group
                    .rows
                    .iter()
                    .map(|row| row.row.as_ref().unwrap().title.as_str())
                    .collect(),
            )
        })
        .collect();
    // The scenario's own project sits in no area, among "Projects", with ours.
    assert_eq!(
        &groups[..2],
        [("Home", vec!["Garden"]), ("Work", vec!["Launch"])]
    );
    assert_eq!(groups[2].0, "Projects");
    assert!(groups[2].1.contains(&"Taxes"));
    assert_eq!(groups.len(), 3);
    let garden = &todo.projects[0].rows[0];
    let row = garden.row.as_ref().unwrap();
    assert_eq!(row.id, "zq-garden");
    assert_eq!(row.meta, "1 task");
    assert!(row.hue_key.starts_with('c'));
    assert_eq!(row.accessibility_label, "Garden, 1 task");
    assert_eq!(
        garden.route,
        Some(agenda::routes::project("zq-garden", "Garden"))
    );
    let projects: usize = todo.projects.iter().map(|group| group.rows.len()).sum();
    assert_eq!(todo.count_label, format!("1 task · {projects} projects"));
    assert_eq!(todo.new_project_label, "New project");
    assert_eq!(todo.empty.as_ref().unwrap().headline, "");
    assert!(!r.state().toolbar.as_ref().unwrap().shown);
    assert_eq!(r.state().destination, Dest::Todo as i32);
}

#[test]
fn the_empty_to_do_action_is_the_new_project_sheet_and_a_to_do_that_holds_anything_has_none() {
    let mut r = rig(Dest::Todo);
    r.clear();
    // The scenario's project stays, so To-do is not empty; its action does nothing.
    assert_eq!(r.todo().empty.as_ref().unwrap().headline, "");
    r.send(H::TodoEmptyActed(
        wire::agenda_home_event::TodoEmptyActed {},
    ));
    assert_eq!(
        r.state().sheet,
        Sheet::None as i32,
        "a To-do that holds anything has no action"
    );
    // Checking the last task off leaves the Inbox empty.
    r.task("zq-done", "Zq Done", None);
    r.settle();
    r.check("zq-done");
    assert!(inbox_titles(&r).is_empty());
}

#[test]
fn the_band_names_to_do_and_the_plus_adds_a_task_there() {
    let mut r = rig(Dest::Todo);
    let state = r.state();
    assert_eq!(
        state
            .band
            .iter()
            .filter(|t| t.current)
            .map(|t| t.key.as_str())
            .collect::<Vec<_>>(),
        ["todo"]
    );
    let tab = state.band.iter().find(|tab| tab.key == "todo").unwrap();
    assert_eq!(
        (tab.label.as_str(), tab.icon_key.as_str()),
        ("To-do", "Todo")
    );
    assert_eq!(state.add_label, "Add task");
    assert!(state.add_opens_quick_add);
    let quick = r.quick();
    assert!(quick.shown && !quick.drawn);
    assert_eq!(quick.lands_label, "Add to Inbox");
    assert_eq!(quick.add_label, "Add task");
    let tasks = r.state().chrome.as_ref().unwrap().tasks.clone().unwrap();
    assert_eq!(tasks.quick_add_placeholder, "Task name");
    assert_eq!(tasks.file_verb, "Move to project");
    assert_eq!(tasks.show_more, "Show more");
    assert_eq!(tasks.new_project_title, "New project");
    // OTHER PLACES: the Plus is the add sheet.
    r.band("day");
    assert_eq!(r.state().add_label, "Add");
    assert!(!r.state().add_opens_quick_add);
    assert!(!r.quick().shown);
}

#[test]
fn the_plus_opens_the_quick_add_and_the_keyboard_leaving_an_empty_bar_puts_it_away_never_typed_words()
 {
    let mut r = rig(Dest::Todo);
    assert!(!r.quick().drawn);
    r.send(H::QuickAddOpened(
        wire::agenda_home_event::QuickAddOpened {},
    ));
    assert!(r.quick().drawn && r.quick().focused);
    r.send(H::QuickAddClosed(
        wire::agenda_home_event::QuickAddClosed {},
    ));
    assert!(!r.quick().drawn);
    r.send(H::QuickAddOpened(
        wire::agenda_home_event::QuickAddOpened {},
    ));
    r.send(H::QuickAddChanged(
        wire::agenda_home_event::QuickAddChanged {
            title: "Buy milk".to_owned(),
        },
    ));
    r.send(H::QuickAddClosed(
        wire::agenda_home_event::QuickAddClosed {},
    ));
    assert!(r.quick().drawn);
    assert_eq!(r.quick().title, "Buy milk");
    assert!(r.quick().can_submit);
    // ANOTHER PLACE, OR SEARCH, puts it away.
    r.open_search();
    assert!(!r.quick().drawn && !r.quick().shown);
    r.close_search();
    r.send(H::QuickAddOpened(
        wire::agenda_home_event::QuickAddOpened {},
    ));
    r.band("schedule");
    assert!(!r.quick().drawn);
    // The Plus is To-do's alone.
    r.send(H::QuickAddOpened(
        wire::agenda_home_event::QuickAddOpened {},
    ));
    assert!(!r.quick().drawn);
}

#[test]
fn quick_add_files_a_bare_title_in_the_inbox_and_the_bar_stays_open_for_the_next_one() {
    let mut r = rig(Dest::Todo);
    r.send(H::QuickAddOpened(
        wire::agenda_home_event::QuickAddOpened {},
    ));
    r.send(H::QuickAddChanged(
        wire::agenda_home_event::QuickAddChanged {
            title: " Zq Buy milk ".to_owned(),
        },
    ));
    assert!(r.quick().can_submit);
    r.send(H::QuickAddSubmitted(
        wire::agenda_home_event::QuickAddSubmitted {},
    ));
    // DRAWN AT ONCE, in the Inbox, with the vault's own row.
    assert!(inbox_titles(&r).contains(&"Zq Buy milk".to_owned()));
    assert_eq!(r.status().unwrap().sentence, "Added to Inbox");
    assert_eq!(r.quick().title, "");
    assert!(r.quick().drawn);
    // TO-DO DATES NOTHING: the Inbox is for work with no day.
    let row = r
        .todo()
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .find(|row| row.title == "Zq Buy milk")
        .unwrap()
        .clone();
    assert_eq!(row.due_label, "");
    // A SECOND SUBMIT with nothing typed files no second task (#1089).
    let count = r
        .todo()
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .filter(|row| row.title == "Zq Buy milk")
        .count();
    r.send(H::QuickAddSubmitted(
        wire::agenda_home_event::QuickAddSubmitted {},
    ));
    assert_eq!(
        r.todo()
            .groups
            .iter()
            .flat_map(|g| &g.rows)
            .filter(|row| row.title == "Zq Buy milk")
            .count(),
        count
    );
    // A blank title files nothing either.
    r.send(H::QuickAddChanged(
        wire::agenda_home_event::QuickAddChanged {
            title: "   ".to_owned(),
        },
    ));
    r.send(H::QuickAddSubmitted(
        wire::agenda_home_event::QuickAddSubmitted {},
    ));
    assert_eq!(
        r.todo()
            .groups
            .iter()
            .flat_map(|g| &g.rows)
            .filter(|row| row.title == "Zq Buy milk")
            .count(),
        count
    );
    // The task is the vault's: it also shows on another surface's read.
    let wire::app_query_response::Answer::TasksBoard(board) = r.read(load::agenda::Board {
        limit: 100,
        view: Some(load::agenda::BoardView::Inbox),
        project_id: None,
    }) else {
        panic!("board");
    };
    assert!(
        board
            .groups
            .iter()
            .flat_map(|g| &g.tasks)
            .any(|t| t.title == "Zq Buy milk")
    );
}

#[test]
fn seeded_words_wait_in_the_bar_and_nothing_is_written_until_added() {
    let mut r = rig_with(Dest::Unspecified, "Zq Send to Agenda");
    assert!(r.quick().drawn && r.quick().focused);
    assert_eq!(r.quick().title, "Zq Send to Agenda");
    assert!(!inbox_titles(&r).contains(&"Zq Send to Agenda".to_owned()));
    r.send(H::QuickAddSubmitted(
        wire::agenda_home_event::QuickAddSubmitted {},
    ));
    assert!(inbox_titles(&r).contains(&"Zq Send to Agenda".to_owned()));
}

#[test]
fn check_off_says_task_done_with_undo_and_undo_brings_the_row_back() {
    let mut r = rig(Dest::Todo);
    r.task("zq-ana", "Zq Call Ana", None);
    r.settle();
    assert!(inbox_titles(&r).contains(&"Zq Call Ana".to_owned()));
    r.check("zq-ana");
    assert!(!inbox_titles(&r).contains(&"Zq Call Ana".to_owned()));
    let status = r.status().unwrap();
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Task done", "Undo")
    );
    r.send(H::StatusActed(wire::agenda_home_event::StatusActed {}));
    assert!(inbox_titles(&r).contains(&"Zq Call Ana".to_owned()));
    assert!(r.status().is_none());
    r.check("zq-ana");
    assert!(
        !inbox_titles(&r).contains(&"Zq Call Ana".to_owned()),
        "again is not a replay of the first"
    );
}

#[test]
fn a_repeating_task_offers_no_undo_and_names_where_its_next_one_landed() {
    let mut r = rig(Dest::Todo);
    r.write(act::agenda::AddTask {
        id: Some("zq-r".to_owned()),
        title: "Zq Water plants".to_owned(),
        due: Field::Is(r.today()),
        rule: Field::Is("FREQ=DAILY".to_owned()),
        ..Default::default()
    });
    r.settle();
    let row = r
        .todo()
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .find(|row| row.title == "Zq Water plants")
        .unwrap()
        .clone();
    assert!(
        row.meta.contains("Daily") || row.meta.to_lowercase().contains("every day"),
        "{}",
        row.meta
    );
    r.check("zq-r");
    let status = r.status().unwrap();
    assert_eq!(
        status.action_label, "",
        "a repeating completion is not undone here"
    );
    assert_eq!(status.sentence, "Task done · the next one is Tomorrow");
}

#[test]
fn filing_is_a_sheet_of_inbox_projects_and_sections_and_the_task_leaves_the_inbox_at_once() {
    let mut r = rig(Dest::Todo);
    r.write(act::agenda::CreateProject {
        kind: act::agenda::CreateProjectKind::Project,
        title: "Zq Garden".to_owned(),
        id: Some("zq-gp".to_owned()),
        ..Default::default()
    });
    r.write(act::agenda::CreateSection {
        title: "Zq Beds".to_owned(),
        parent: "zq-gp".to_owned(),
        id: Some("zq-gs".to_owned()),
        ..Default::default()
    });
    r.task("zq-seeds", "Zq Seeds", None);
    r.task("zq-bulbs", "Zq Bulbs", None);
    r.settle();
    let row = r
        .todo()
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .find(|row| row.title == "Zq Seeds")
        .unwrap()
        .clone();
    assert!(row.can_file);
    r.send(H::FileRequested(wire::agenda_home_event::FileRequested {
        task_id: "zq-seeds".to_owned(),
    }));
    assert_eq!(r.state().sheet, Sheet::File as i32);
    assert_eq!(r.state().filing_task_id, "zq-seeds");
    let keys: Vec<&str> = r
        .state()
        .file_choices
        .iter()
        .map(|c| c.key.as_str())
        .collect();
    assert_eq!(keys.first(), Some(&"inbox"));
    let project_at = keys
        .iter()
        .position(|key| *key == "project:zq-gp")
        .expect("the project is a choice");
    assert_eq!(
        keys[project_at + 1],
        "section:zq-gs",
        "a section sits under its project"
    );
    // THE TASK'S OWN PLACE is selected: the Inbox.
    assert!(r.state().file_choices[0].selected);
    assert!(r.state().file_choices[project_at + 1].indented);
    // A project.
    r.send(H::FileChosen(wire::agenda_home_event::FileChosen {
        key: "project:zq-gp".to_owned(),
    }));
    assert_eq!(r.state().sheet, Sheet::None as i32);
    assert_eq!(r.state().filing_task_id, "");
    assert!(r.state().file_choices.is_empty());
    assert!(
        !inbox_titles(&r).contains(&"Zq Seeds".to_owned()),
        "filed, it leaves the Inbox at once"
    );
    assert_eq!(r.status().unwrap().sentence, "Filed in Zq Garden");
    // A section: the project and the section both.
    r.send(H::FileRequested(wire::agenda_home_event::FileRequested {
        task_id: "zq-bulbs".to_owned(),
    }));
    r.send(H::FileChosen(wire::agenda_home_event::FileChosen {
        key: "section:zq-gs".to_owned(),
    }));
    assert_eq!(r.status().unwrap().sentence, "Filed in Zq Garden · Zq Beds");
    assert!(!inbox_titles(&r).contains(&"Zq Bulbs".to_owned()));
    // The vault holds what the sheet said.
    let wire::app_query_response::Answer::TasksTask(detail) = r.read(load::agenda::Task {
        task_id: "zq-bulbs".to_owned(),
    }) else {
        panic!("task");
    };
    let task = detail.task.unwrap();
    assert_eq!(
        (task.project_id.as_deref(), task.section_id.as_deref()),
        (Some("zq-gp"), Some("zq-gs"))
    );
    // A KEY THE SHEET NO LONGER HOLDS files nothing and shuts it.
    r.task("zq-tools", "Zq Tools", None);
    r.settle();
    r.send(H::FileRequested(wire::agenda_home_event::FileRequested {
        task_id: "zq-tools".to_owned(),
    }));
    r.send(H::FileChosen(wire::agenda_home_event::FileChosen {
        key: "project:gone".to_owned(),
    }));
    assert_eq!(r.state().sheet, Sheet::None as i32);
    assert!(inbox_titles(&r).contains(&"Zq Tools".to_owned()));
    // A task that is not on screen opens no sheet; a sheet closed by hand drops the task.
    r.send(H::FileRequested(wire::agenda_home_event::FileRequested {
        task_id: "nope".to_owned(),
    }));
    assert_eq!(r.state().sheet, Sheet::None as i32);
    r.send(H::FileRequested(wire::agenda_home_event::FileRequested {
        task_id: "zq-tools".to_owned(),
    }));
    r.send(H::SheetClosed(wire::agenda_home_event::SheetClosed {}));
    assert_eq!(r.state().filing_task_id, "");
}

#[test]
fn a_new_project_is_a_sheet_reachable_from_to_do_whatever_it_holds() {
    let mut r = rig(Dest::Todo);
    assert_eq!(r.todo().new_project_label, "New project");
    r.send(H::SheetOpened(wire::agenda_home_event::SheetOpened {
        sheet: Sheet::NewProject as i32,
    }));
    assert_eq!(r.state().sheet, Sheet::NewProject as i32);
    assert!(!r.state().new_project_can_submit);
    r.send(H::NewProjectName(
        wire::agenda_home_event::NewProjectNameChanged {
            name: "Zq Garden".to_owned(),
        },
    ));
    assert!(r.state().new_project_can_submit);
    // Closing the sheet drops the name.
    r.send(H::SheetClosed(wire::agenda_home_event::SheetClosed {}));
    assert_eq!(r.state().new_project_name, "");
    r.send(H::SheetOpened(wire::agenda_home_event::SheetOpened {
        sheet: Sheet::NewProject as i32,
    }));
    r.send(H::NewProjectName(
        wire::agenda_home_event::NewProjectNameChanged {
            name: "Zq Garden".to_owned(),
        },
    ));
    r.send(H::NewProjectSubmitted(
        wire::agenda_home_event::NewProjectSubmitted {},
    ));
    assert_eq!(r.state().sheet, Sheet::None as i32);
    assert_eq!(r.state().new_project_name, "");
    assert_eq!(r.status().unwrap().sentence, "Project created");
    let projects: Vec<String> = r
        .todo()
        .projects
        .iter()
        .flat_map(|group| {
            group
                .rows
                .iter()
                .map(|row| row.row.as_ref().unwrap().title.clone())
        })
        .collect();
    assert!(projects.contains(&"Zq Garden".to_owned()));
    // A blank name makes nothing.
    r.send(H::SheetOpened(wire::agenda_home_event::SheetOpened {
        sheet: Sheet::NewProject as i32,
    }));
    r.send(H::NewProjectSubmitted(
        wire::agenda_home_event::NewProjectSubmitted {},
    ));
    assert_eq!(r.state().sheet, Sheet::NewProject as i32);
}

#[test]
fn the_window_says_when_it_is_not_everything_and_show_more_widens_it_to_the_ceiling() {
    let mut r = rig(Dest::Todo);
    r.clear();
    for n in 0..101 {
        r.task(&format!("zq-bulk-{n}"), &format!("Zq Bulk {n}"), None);
    }
    r.settle();
    let todo = r.todo();
    assert_eq!(todo.window_label, "100 tasks · more not shown");
    assert!(todo.can_show_more);
    r.send(H::NextPage(wire::agenda_home_event::NextPageRequested {}));
    let todo = r.todo();
    assert_eq!(todo.window_label, "", "the whole Inbox fits now");
    assert!(!todo.can_show_more);
    assert!(
        todo.count_label.starts_with("101 tasks"),
        "{}",
        todo.count_label
    );
}

#[test]
fn to_do_reads_again_after_a_change() {
    let mut r = rig(Dest::Todo);
    r.task("zq-live", "Zq Live", None);
    r.driver.pump(Duration::from_millis(500));
    assert!(inbox_titles(&r).contains(&"Zq Live".to_owned()));
    r.band("day");
    assert_eq!(r.state().destination, Dest::Day as i32);
    r.task("zq-live-2", "Zq Live 2", Some(&r.today()));
    r.driver.pump(Duration::from_millis(500));
    r.band("todo");
    assert!(
        r.todo()
            .groups
            .iter()
            .flat_map(|g| &g.rows)
            .any(|row| row.title == "Zq Live 2")
    );
}

#[test]
fn a_write_to_a_table_agenda_never_read_redraws_nothing() {
    let mut r = rig(Dest::Schedule);
    let before = r.driver.view(r.id).revision;
    r.write(act::locker::AddItem {
        r#type: act::locker::AddItemType::Note,
        title: "Zq secret note".to_owned(),
        ..Default::default()
    });
    r.driver.pump(Duration::from_millis(400));
    assert_eq!(
        r.driver.view(r.id).revision,
        before,
        "no table the screen read changed"
    );
}

#[test]
fn the_add_sheet_opens_on_the_anchor_day() {
    let mut r = rig(Dest::Day);
    r.step(3);
    assert_eq!(
        r.state().new_event,
        Some(agenda::routes::editor(
            "",
            "",
            None,
            &r.day(3),
            wire::AgendaEditorKind::Unspecified
        ))
    );
    // A sheet nobody named opens nothing.
    r.send(H::SheetOpened(wire::agenda_home_event::SheetOpened {
        sheet: Sheet::Unspecified as i32,
    }));
    assert_eq!(r.state().sheet, Sheet::None as i32);
}

// ---------------------------------------------------------------------------
// The phone's calendar (CalendarFollow is hosted by the home)
// ---------------------------------------------------------------------------

#[test]
fn the_home_asks_whether_this_device_follows_and_the_import_tap_asks_the_shell_to_read_the_calendars()
 {
    let mut rig = rig(Dest::Day);
    let asked = |driver: &Driver| -> Vec<wire::effect::Kind> {
        driver
            .effects
            .iter()
            .filter_map(|request| request.effect.as_ref()?.kind.clone())
            .collect()
    };
    assert!(
        asked(&rig.driver)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::Keychain(_))),
        "the home learns on opening whether this device follows"
    );
    rig.driver
        .answer_effect(wire::effect_result::Outcome::Keychain(
            wire::KeychainValue {
                found: false,
                value: Vec::new(),
            },
        ));
    rig.driver.effects.clear();
    rig.driver.send(
        rig.id,
        E::AgendaHome(wire::AgendaHomeEvent {
            kind: Some(H::ImportRequested(
                wire::agenda_home_event::ImportRequested {},
            )),
        }),
    );
    assert!(
        asked(&rig.driver)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::CalendarRead(_))),
        "{:?}",
        asked(&rig.driver)
    );
}
