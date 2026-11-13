//! A vault, a London phone and the doors a test arranges data through, shared
//! by the event, editor and calendar tests (each is its own test crate, so a
//! helper one of them does not use is dead there).
#![allow(dead_code)]

#[allow(clippy::duplicate_mod)]
#[path = "../schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::{Field, Keyed};
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime, proof};
use wire::screen_event::Kind as E;

pub const ZONE: &str = "Europe/London";

pub struct World {
    pub driver: Driver,
    pub me: String,
    /// The other people the vault lists, by name.
    pub people: Vec<(String, String)>,
    seq: u64,
}

impl World {
    /// The example vault, the event and editor screens on the `agenda` tab, and
    /// a phone in London. The tab's root is the runtime's proof screen, so these
    /// tests stand on no other Agenda screen.
    pub fn new() -> Self {
        Self::with(Registry::default())
    }

    /// [`Self::new`] with more screens registered.
    pub fn with(registry: Registry) -> Self {
        Self::build(registry, None)
    }

    /// [`Self::with`], and the follow coordinator (`centraid_screens::follow`) running beside it
    /// as a service, so the phone's calendar is followed the way the app follows it.
    pub fn following(registry: Registry) -> Self {
        Self::build_with(registry, None, true)
    }

    /// [`Self::new`] over a vault seeded as of `now_ms` rather than the machine's clock, so a
    /// result cannot turn on the day of the week the suite runs.
    pub fn seeded_at(now_ms: i64) -> Self {
        Self::build(Registry::default(), Some(now_ms))
    }

    /// [`Self::with`] over a vault seeded as of `now_ms`.
    pub fn seeded_with(registry: Registry, now_ms: i64) -> Self {
        Self::build(registry, Some(now_ms))
    }

    fn build(registry: Registry, seeded_at_ms: Option<i64>) -> Self {
        Self::build_with(registry, seeded_at_ms, false)
    }

    fn build_with(registry: Registry, seeded_at_ms: Option<i64>, following: bool) -> Self {
        let registry = if following {
            registry.merge(centraid_screens::follow::registry())
        } else {
            registry
        };
        let registry = registry
            .with(proof::NAME, proof::build)
            .with(
                centraid_screens::calendar::EVENT,
                centraid_screens::calendar::event::build,
            )
            .with(
                centraid_screens::calendar::EDITOR,
                centraid_screens::calendar::editor::build,
            );
        let runtime = Runtime::new(registry, vec![(agenda::TAB.to_owned(), proof::route())]);
        let runtime = if following {
            runtime.with_services(centraid_screens::follow::services())
        } else {
            runtime
        };
        let mut driver = match seeded_at_ms {
            Some(now_ms) => Driver::with_runtime_at(runtime, now_ms),
            None => Driver::with_runtime(runtime),
        };
        driver.start();
        driver.call(wire::screen_request::Kind::Environment(wire::Environment {
            locale: "en".to_owned(),
            zone: ZONE.to_owned(),
            ..Default::default()
        }));
        let parties = driver
            .handle
            .load(&load::calendar::Parties::default().into())
            .expect("parties load");
        let Some(wire::app_query_response::Answer::AgendaParties(parties)) =
            parties.answer.and_then(|a| a.answer)
        else {
            panic!("parties answered something else");
        };
        let me = parties.me.expect("the owner has a party");
        let people = parties
            .parties
            .iter()
            .filter(|party| !party.is_you)
            .map(|party| (party.name.clone(), party.party_id.clone()))
            .collect();
        let mut world = Self {
            driver,
            me,
            people,
            seq: 0,
        };
        world.clear_the_example_agenda();
        world
    }

    /// The example vault seeds its agenda around the wall clock, a weekly run
    /// from tomorrow among it, so on the weekday before a test's 2099 week the
    /// run lands in that week. Trash every seeded event: each test arranges the
    /// events it counts.
    fn clear_the_example_agenda(&mut self) {
        let mut seeded: Vec<String> = self
            .window("1970-01-01T00:00:00Z", "2099-01-01T00:00:00Z")
            .into_iter()
            .map(|event| event.event_id)
            .collect();
        seeded.sort();
        seeded.dedup();
        for event_id in seeded {
            self.act(act::calendar::TrashEvent { event_id });
        }
    }

    pub fn person(&self, name: &str) -> String {
        self.people
            .iter()
            .find(|(known, _)| known == name)
            .unwrap_or_else(|| panic!("no one called {name}: {:?}", self.people))
            .1
            .clone()
    }

    /// Switch the phone to another zone.
    pub fn zone(&mut self, zone: &str) {
        self.driver
            .call(wire::screen_request::Kind::Environment(wire::Environment {
                locale: "en".to_owned(),
                zone: zone.to_owned(),
                ..Default::default()
            }));
    }

    pub fn key(&mut self, what: &str) -> String {
        self.seq += 1;
        format!("test:{what}:{}", self.seq)
    }

    /// Write as another surface would; the vault must take it.
    pub fn act(&mut self, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
        let key = self.key("act");
        let done = self.driver.act(request.into().keyed(key));
        assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");
        done
    }

    /// Propose an event on London's wall clock; the id it was given.
    pub fn propose(
        &mut self,
        title: &str,
        starts: &str,
        ends: &str,
        more: impl FnOnce(&mut act::calendar::Propose),
    ) -> String {
        let mut propose = act::calendar::Propose {
            title: title.to_owned(),
            starts: starts.to_owned(),
            ends: Field::Is(ends.to_owned()),
            zone: Field::Is(ZONE.to_owned()),
            ..act::calendar::Propose::default()
        };
        more(&mut propose);
        let done = self.act(propose);
        let output: serde_json::Value = serde_json::from_slice(&done.output).expect("json output");
        output["id"].as_str().expect("the id").to_owned()
    }

    /// A weekday series at 10:00 from Monday 15 June 2099 (a busy series: two at
    /// one time conflict, so a second one passes `hour`).
    pub fn weekdays(&mut self, title: &str) -> String {
        self.weekdays_at(title, 10)
    }

    pub fn weekdays_at(&mut self, title: &str, hour: u32) -> String {
        self.propose(
            title,
            &format!("2099-06-15T{hour:02}:00:00"),
            &format!("2099-06-15T{hour:02}:15:00"),
            |p| {
                p.rule = Field::Is("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR".to_owned());
            },
        )
    }

    pub fn load(&self, request: impl Into<wire::LoadRequest>) -> wire::app_query_response::Answer {
        let mut request: wire::LoadRequest = request.into();
        request.zone = ZONE.to_owned();
        self.driver
            .handle
            .load(&request)
            .expect("the load door answers")
            .answer
            .and_then(|answer| answer.answer)
            .expect("an answer")
    }

    /// What the vault holds of one event now.
    pub fn event_row(&self, id: &str) -> Option<wire::AgendaEvent> {
        let wire::app_query_response::Answer::AgendaEvent(detail) =
            self.load(load::calendar::Event {
                event_id: id.to_owned(),
                ..load::calendar::Event::default()
            })
        else {
            panic!("event answered something else");
        };
        detail.event
    }

    pub fn calendar_names(&self) -> Vec<(String, String)> {
        let wire::app_query_response::Answer::AgendaUpcoming(upcoming) =
            self.load(load::calendar::Upcoming {
                from: Some("1970-01-01T00:00:00Z".to_owned()),
                to: Some("1970-01-01T00:00:01Z".to_owned()),
                alerts: None,
            })
        else {
            panic!("upcoming answered something else");
        };
        upcoming
            .calendars
            .iter()
            .map(|c| (c.calendar_id.clone(), c.name.clone().unwrap_or_default()))
            .collect()
    }

    /// The events of a window, in the phone's zone.
    pub fn window(&self, from: &str, to: &str) -> Vec<wire::AgendaEvent> {
        let wire::app_query_response::Answer::AgendaUpcoming(upcoming) =
            self.load(load::calendar::Upcoming {
                from: Some(from.to_owned()),
                to: Some(to.to_owned()),
                alerts: None,
            })
        else {
            panic!("upcoming answered something else");
        };
        upcoming.events
    }

    /// The core's today and now on the phone's wall clock.
    pub fn today(&self) -> (String, String) {
        let wire::app_query_response::Answer::AgendaUpcoming(upcoming) =
            self.load(load::calendar::Upcoming {
                from: Some("1970-01-01T00:00:00Z".to_owned()),
                to: Some("1970-01-01T00:00:01Z".to_owned()),
                alerts: None,
            })
        else {
            panic!("upcoming answered something else");
        };
        (upcoming.today, upcoming.now_local)
    }

    /// Every task on the board with this title.
    pub fn tasks_titled(&self, title: &str) -> Vec<wire::AgendaTask> {
        let wire::app_query_response::Answer::AgendaTaskBoard(board) =
            self.load(load::reminders::Board {
                limit: 200,
                view: Some(load::reminders::BoardView::All),
                ..load::reminders::Board::default()
            })
        else {
            panic!("board answered something else");
        };
        board
            .groups
            .into_iter()
            .flat_map(|group| group.tasks)
            .filter(|task| task.title == title)
            .collect()
    }

    // -- the event page ----------------------------------------------------

    pub fn open_event(
        &mut self,
        id: &str,
        instance_key: &str,
        original: Option<&str>,
        day: &str,
    ) -> u64 {
        self.driver
            .push(agenda::TAB, routes::event(id, instance_key, original, day))
    }

    pub fn event_state(&self, instance: u64) -> &wire::AgendaEventState {
        match &self.driver.view(instance).kind {
            Some(wire::view_state::Kind::AgendaEvent(state)) => state,
            other => panic!("not an event page: {other:?}"),
        }
    }

    pub fn event_data(&self, instance: u64) -> &wire::AgendaEventData {
        match &self.event_state(instance).content {
            Some(wire::agenda_event_state::Content::Data(data)) => data,
            other => panic!("the event page has no data: {other:?}"),
        }
    }

    pub fn send_event(&mut self, instance: u64, kind: wire::agenda_event_event::Kind) {
        self.driver.send(
            instance,
            E::AgendaEvent(wire::AgendaEventEvent { kind: Some(kind) }),
        );
    }

    // -- the editor ---------------------------------------------------------

    pub fn open_new(&mut self, day: &str, kind: wire::AgendaEditorKind) -> u64 {
        self.driver
            .push(agenda::TAB, routes::editor("", "", None, day, kind))
    }

    pub fn open_edit(
        &mut self,
        id: &str,
        instance_key: &str,
        original: Option<&str>,
        day: &str,
    ) -> u64 {
        self.driver.push(
            agenda::TAB,
            routes::editor(
                id,
                instance_key,
                original,
                day,
                wire::AgendaEditorKind::Event,
            ),
        )
    }

    pub fn editor_state(&self, instance: u64) -> &wire::AgendaEditorState {
        match &self.driver.view(instance).kind {
            Some(wire::view_state::Kind::AgendaEditor(state)) => state,
            other => panic!("not an editor: {other:?}"),
        }
    }

    pub fn editor_data(&self, instance: u64) -> &wire::AgendaEditorData {
        match &self.editor_state(instance).content {
            Some(wire::agenda_editor_state::Content::Data(data)) => data,
            other => panic!("the editor has no data: {other:?}"),
        }
    }

    pub fn draft(&self, instance: u64) -> &wire::AgendaDraft {
        self.editor_data(instance).draft.as_ref().expect("a draft")
    }

    pub fn send_editor(
        &mut self,
        instance: u64,
        kind: wire::agenda_editor_event::Kind,
    ) -> wire::ScreenUpdate {
        self.driver.send(
            instance,
            E::AgendaEditor(wire::AgendaEditorEvent { kind: Some(kind) }),
        )
    }

    pub fn title(&mut self, instance: u64, text: &str) {
        self.send_editor(
            instance,
            wire::agenda_editor_event::Kind::Title(wire::agenda_editor_event::TitleChanged {
                text: text.to_owned(),
            }),
        );
    }

    pub fn save(&mut self, instance: u64) -> wire::ScreenUpdate {
        self.send_editor(
            instance,
            wire::agenda_editor_event::Kind::Save(wire::agenda_editor_event::SaveTapped {}),
        )
    }
}

/// The effect kinds an update asked for, oldest first.
pub fn asked(update: &wire::ScreenUpdate) -> Vec<&wire::effect::Kind> {
    update
        .effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.as_ref())
        .collect()
}
