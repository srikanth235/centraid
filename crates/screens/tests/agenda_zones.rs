//! ONE EVENT, ONE WALL CLOCK, ON EVERY PATH (#1173, round 6): the event page, the editor, the
//! day grid, the week grid and the widget row all read an event through the same conversion,
//! so on a phone that is not in UTC they say the same time.
//!
//! These run under a positive offset (Asia/Kolkata, +05:30, the zone the bug was seen in) and a
//! negative one (America/Los_Angeles) because a conversion that is applied twice, or not at all,
//! is invisible in UTC, which is how this slipped past every earlier test. The zone is the
//! phone's STATED zone (the environment a shell sends), never the host's clock and never `TZ`.
//!
//! Every day is read off the core's own `today`, so no assertion is on the machine's clock, and
//! none is on a duration: only on values.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, glance, routes};
use centraid_screens::catalog::{act, load};
use centraid_screens::field::{Field, Keyed};
use centraid_screens::kit::civil;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime};
use serde_json::Value;
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::screen_event::Kind as E;

/// A phone in `zone`: the example vault, Agenda's screens and the widget's service.
struct Phone {
    driver: Driver,
    zone: String,
    home: u64,
    seq: u64,
}

impl Phone {
    /// A phone on an empty agenda (`clear`), or on the example vault's own week.
    fn new(zone: &str, clear: bool) -> Self {
        let mut driver = Driver::with_runtime(
            Runtime::new(
                Registry::default()
                    .merge(agenda::registry())
                    .merge(glance::registry()),
                vec![(agenda::TAB.to_owned(), routes::home(Dest::Day, ""))],
            )
            .with_services(glance::services()),
        );
        driver.start();
        driver.call(wire::screen_request::Kind::Environment(wire::Environment {
            locale: "en".to_owned(),
            zone: zone.to_owned(),
            ..Default::default()
        }));
        let home = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
        let mut phone = Self {
            driver,
            zone: zone.to_owned(),
            home,
            seq: 0,
        };
        if clear {
            phone.clear_the_example_agenda();
        }
        phone
    }

    /// The example vault seeds events around the wall clock; each test counts its own.
    fn clear_the_example_agenda(&mut self) {
        let mut seeded: Vec<String> = self
            .upcoming("1970-01-01T00:00:00Z", "2099-01-01T00:00:00Z")
            .events
            .into_iter()
            .map(|event| event.event_id)
            .collect();
        seeded.sort();
        seeded.dedup();
        for event_id in seeded {
            self.write(act::agenda::TrashEvent { event_id });
        }
    }

    fn read(&self, request: impl Into<wire::LoadRequest>) -> wire::app_query_response::Answer {
        let mut request: wire::LoadRequest = request.into();
        request.zone.clone_from(&self.zone);
        self.driver
            .handle
            .load(&request)
            .expect("the load door answers")
            .answer
            .and_then(|answer| answer.answer)
            .expect("an answer")
    }

    fn upcoming(&self, from: &str, to: &str) -> wire::AgendaUpcoming {
        let wire::app_query_response::Answer::AgendaUpcoming(upcoming) =
            self.read(load::agenda::Upcoming {
                from: Some(from.to_owned()),
                to: Some(to.to_owned()),
            })
        else {
            panic!("upcoming answered something else");
        };
        upcoming
    }

    fn write(&mut self, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
        self.seq += 1;
        let done = self
            .driver
            .act(request.into().keyed(format!("zq-zones:{}", self.seq)));
        assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");
        done
    }

    /// The core's today on this phone's wall clock, and the day after it.
    fn tomorrow(&self) -> String {
        let today = self
            .upcoming("1970-01-01T00:00:00Z", "1970-01-01T00:00:01Z")
            .today;
        civil::plus_days(&today, 1).expect("a day")
    }

    /// An event as the phone writes it: a wall clock and the phone's own zone.
    fn propose(
        &mut self,
        id: &str,
        title: &str,
        day: &str,
        from: &str,
        to: &str,
        rule: Option<&str>,
    ) {
        let zone = self.zone.clone();
        self.propose_in(id, title, &zone, day, from, to, rule);
    }

    #[allow(clippy::too_many_arguments)]
    fn propose_in(
        &mut self,
        id: &str,
        title: &str,
        zone: &str,
        day: &str,
        from: &str,
        to: &str,
        rule: Option<&str>,
    ) {
        self.write(act::agenda::Propose {
            id: Some(id.to_owned()),
            title: title.to_owned(),
            starts: format!("{day}T{from}"),
            ends: Field::Is(format!("{day}T{to}")),
            busy: Some(false),
            zone: Field::Is(zone.to_owned()),
            rule: rule.map_or(Field::Keep, |rule| Field::Is(rule.to_owned())),
            ..Default::default()
        });
    }

    /// The occurrence of `id` the core answers on `day`, in this phone's zone.
    fn occurrence(&self, id: &str, day: &str) -> wire::AgendaEvent {
        let from = format!("{}T00:00:00Z", civil::plus_days(day, -2).expect("a day"));
        let to = format!("{}T00:00:00Z", civil::plus_days(day, 3).expect("a day"));
        self.upcoming(&from, &to)
            .events
            .into_iter()
            .find(|event| event.event_id == id && event.local_start.starts_with(day))
            .unwrap_or_else(|| panic!("no {id} on {day}"))
    }

    // -- the paths ----------------------------------------------------------

    /// The event page's date and time lines.
    fn page(&mut self, event: &wire::AgendaEvent, day: &str) -> wire::AgendaEventData {
        let instance = self.driver.push(
            agenda::TAB,
            routes::event(
                &event.event_id,
                &event.instance_key,
                event.original_start_local.as_deref(),
                day,
            ),
        );
        match &self.driver.view(instance).kind {
            Some(wire::view_state::Kind::AgendaEvent(state)) => match &state.content {
                Some(wire::agenda_event_state::Content::Data(data)) => (**data).clone(),
                other => panic!("the event page has no data: {other:?}"),
            },
            other => panic!("not an event page: {other:?}"),
        }
    }

    /// The editor's draft on the same occurrence.
    fn editor(&mut self, event: &wire::AgendaEvent, day: &str) -> wire::AgendaDraft {
        let instance = self.driver.push(
            agenda::TAB,
            routes::editor(
                &event.event_id,
                &event.instance_key,
                event.original_start_local.as_deref(),
                day,
                wire::AgendaEditorKind::Event,
            ),
        );
        match &self.driver.view(instance).kind {
            Some(wire::view_state::Kind::AgendaEditor(state)) => match &state.content {
                Some(wire::agenda_editor_state::Content::Data(data)) => {
                    data.draft.clone().expect("a draft")
                }
                other => panic!("the editor has no data: {other:?}"),
            },
            other => panic!("not an editor: {other:?}"),
        }
    }

    /// The Calendar's grid block of the event, on `destination` opened at `day`.
    fn grid_label(&mut self, destination: Dest, day: &str, key: &str) -> String {
        self.driver.send(
            self.home,
            E::AgendaHome(wire::AgendaHomeEvent {
                kind: Some(H::DayPicked(wire::agenda_home_event::DayPicked {
                    day: day.to_owned(),
                    destination: destination as i32,
                })),
            }),
        );
        self.driver.pump(Duration::from_millis(400));
        let Some(wire::view_state::Kind::AgendaHome(state)) = &self.driver.view(self.home).kind
        else {
            panic!("not Agenda's home");
        };
        let Some(wire::agenda_home_state::Content::Data(data)) = &state.content else {
            panic!("no home data: {:?}", state.content);
        };
        data.time_grid
            .as_ref()
            .expect("the hour grid")
            .days
            .iter()
            .find(|column| column.day == day)
            .unwrap_or_else(|| panic!("no column {day}"))
            .blocks
            .iter()
            .find(|block| block.instance_key == key)
            .unwrap_or_else(|| panic!("no block {key} on {day}"))
            .time_label
            .clone()
    }

    /// The widget's `up_next` row for the event, from a fresh snapshot.
    fn widget(&self, key: &str) -> Value {
        // THE WRITE ITSELF TOLD THE SERVICE: the last document it asked a shell to keep is the
        // one the widget would draw.
        let document = self
            .driver
            .effects
            .iter()
            .rev()
            .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                wire::effect::Kind::AgendaGlance(glance) => {
                    Some(serde_json::from_slice::<Value>(&glance.document).expect("JSON"))
                }
                _ => None,
            })
            .expect("a snapshot was asked for");
        document["up_next"]
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row["open"].as_str().is_some_and(|o| o.contains(key)))
            })
            .unwrap_or_else(|| panic!("no widget row for {key}: {document}"))
            .clone()
    }
}

/// "19:00 – 21:00" from the core's wall-clock instants.
fn clock(local: &str) -> &str {
    local.get(11..16).unwrap_or_default()
}

/// Every path says `from – to` for the event the phone wrote in its own zone.
fn the_paths_agree(zone: &str, rule: Option<&str>) {
    let mut phone = Phone::new(zone, true);
    let day = phone.tomorrow();
    phone.propose("zq-dinner", "Zq dinner", &day, "19:00", "21:00", rule);
    let event = phone.occurrence("zq-dinner", &day);
    // What the member typed is what the core answers: no hour was added or taken away.
    assert_eq!(
        (clock(&event.local_start), clock(&event.local_end)),
        ("19:00", "21:00"),
        "{zone}: the read"
    );
    assert!(event.local_start.starts_with(&day), "{zone}: {event:?}");

    let label = "19:00 \u{2013} 21:00";
    assert_eq!(phone.page(&event, &day).when_label, label, "{zone}: page");
    let draft = phone.editor(&event, &day);
    assert_eq!(
        (
            draft.start_day.as_str(),
            draft.start_time.as_str(),
            draft.end_time.as_str()
        ),
        (day.as_str(), "19:00", "21:00"),
        "{zone}: editor"
    );
    assert_eq!(draft.zone, zone, "{zone}: the editor's zone is the phone's");
    let key = if event.instance_key.is_empty() {
        event.event_id.clone()
    } else {
        event.instance_key.clone()
    };
    assert_eq!(
        phone.grid_label(Dest::Day, &day, &key),
        label,
        "{zone}: day grid"
    );
    assert_eq!(
        phone.grid_label(Dest::Week, &day, &key),
        label,
        "{zone}: week grid"
    );
    let row = phone.widget("zq-dinner");
    assert_eq!(
        clock(row["starts_local"].as_str().unwrap_or_default()),
        "19:00",
        "{zone}: widget"
    );
    assert_eq!(
        clock(row["ends_local"].as_str().unwrap_or_default()),
        "21:00",
        "{zone}: widget end"
    );
}

#[test]
fn a_single_event_reads_alike_on_every_path_east_of_utc() {
    the_paths_agree("Asia/Kolkata", None);
}

#[test]
fn a_single_event_reads_alike_on_every_path_west_of_utc() {
    the_paths_agree("America/Los_Angeles", None);
}

#[test]
fn an_occurrence_of_a_series_reads_alike_on_every_path_east_of_utc() {
    the_paths_agree("Asia/Kolkata", Some("FREQ=DAILY"));
}

#[test]
fn an_occurrence_of_a_series_reads_alike_on_every_path_west_of_utc() {
    the_paths_agree("America/Los_Angeles", Some("FREQ=DAILY"));
}

/// THE EXAMPLE VAULT'S WEEK IS THE MEMBER'S OWN WALL CLOCK. It was seeded as UTC instants in
/// `Etc/UTC`, so on any phone that is not in UTC every seeded event was an event "in another
/// zone": the page read Dinner at 00:30 Thursday on the phone's clock, and the editor, which
/// opens such an event in its own zone, read it at 19:00 Wednesday. Seeded events are
/// floating now ("19:00 wherever the member is"), so every phone reads 19:00.
fn the_example_week_reads_alike(zone: &str) {
    let mut phone = Phone::new(zone, false);
    let events = phone
        .upcoming("1970-01-01T00:00:00Z", "2099-01-01T00:00:00Z")
        .events;
    let dinner = events
        .into_iter()
        .find(|event| event.summary.as_deref() == Some("Dinner with Maya"))
        .expect("the example vault has its dinner");
    assert_eq!(
        (clock(&dinner.local_start), clock(&dinner.local_end)),
        ("19:00", "21:00"),
        "{zone}: the read"
    );
    let day = dinner.local_start[..10].to_owned();
    assert_eq!(
        phone.page(&dinner, &day).when_label,
        "19:00 \u{2013} 21:00",
        "{zone}: page"
    );
    let draft = phone.editor(&dinner, &day);
    assert_eq!(
        (draft.start_day.as_str(), draft.start_time.as_str()),
        (day.as_str(), "19:00"),
        "{zone}: editor"
    );
    assert!(
        phone
            .page(&dinner, &day)
            .facts
            .iter()
            .all(|fact| fact.label != "Time zone"),
        "{zone}: a floating event names no zone"
    );
}

#[test]
fn the_example_week_reads_alike_east_of_utc() {
    the_example_week_reads_alike("Asia/Kolkata");
}

#[test]
fn the_example_week_reads_alike_west_of_utc() {
    the_example_week_reads_alike("America/Los_Angeles");
}

/// AN EVENT IN ANOTHER ZONE reads on the phone's clock on the page, the grids and the widget,
/// with its own zone named as a fact; the editor edits the clock it was made in, and says so
/// in its zone row. Both are deliberate: a Tokyo meeting is 10:00 to the person who made it and
/// 02:00 to a phone in London, and a zone picked in the editor keeps the wall clock.
#[test]
fn an_event_in_another_zone_is_the_phones_clock_on_the_page_and_its_own_in_the_editor() {
    let mut phone = Phone::new("Asia/Kolkata", true);
    let day = phone.tomorrow();
    phone.propose_in("zq-utc", "Zq utc", "Etc/UTC", &day, "19:00", "21:00", None);
    let event = phone
        .upcoming("1970-01-01T00:00:00Z", "2099-01-01T00:00:00Z")
        .events
        .into_iter()
        .find(|event| event.event_id == "zq-utc")
        .expect("the event");
    // 19:00 UTC is 00:30 the next day in Kolkata.
    assert_eq!(
        (clock(&event.local_start), clock(&event.local_end)),
        ("00:30", "02:30")
    );
    let shown = event.local_start[..10].to_owned();
    assert_eq!(shown, civil::plus_days(&day, 1).expect("a day"));

    let page = phone.page(&event, &shown);
    assert_eq!(page.when_label, "00:30 \u{2013} 02:30");
    assert!(
        page.facts
            .iter()
            .any(|fact| fact.label == "Time zone" && fact.detail == "UTC, Etc"),
        "the page names the zone the event is in: {:?}",
        page.facts
    );
    assert_eq!(
        phone.grid_label(Dest::Day, &shown, &event.event_id),
        "00:30 \u{2013} 02:30"
    );
    let draft = phone.editor(&event, &shown);
    assert_eq!(
        (
            draft.zone.as_str(),
            draft.start_day.as_str(),
            draft.start_time.as_str()
        ),
        ("Etc/UTC", day.as_str(), "19:00")
    );
}
