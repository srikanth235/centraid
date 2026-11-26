//! The room runtime: selectors, the shared text field, keep-my-place and reload-on-write, driven
//! through the same `RoomEvent`s a shell sends.

use std::sync::{Arc, Mutex};

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::notes;
use centraid_screens::room::blocks;
use centraid_screens::room::form::{self, Save};
use centraid_screens::room::frame::room;
use centraid_screens::room::selector::{Act, Handler};
use centraid_screens::room::{
    Build, Done, Door, Event, Input, Outcome, Refusal, Refused, Registry, RoomError, RoomScreen,
    Rooms, Shown, snapshot,
};
use serde_json::json;

#[derive(Default)]
struct Recorder {
    acts: Mutex<Vec<String>>,
    undone: Mutex<u32>,
    refuse: Mutex<bool>,
}

impl Door for Recorder {
    fn act(&self, act: &Act) -> Result<Done, Refused> {
        if *self.refuse.lock().unwrap() {
            return Err(Refused("That note changed. Reload.".to_owned()));
        }
        self.acts.lock().unwrap().push(act.name.clone());
        Ok(Done {
            sentence: "Note moved to trash".to_owned(),
            undo: true,
        })
    }

    fn undo(&self) -> Result<Done, Refused> {
        *self.undone.lock().unwrap() += 1;
        Ok(Done {
            sentence: "Back where it was".to_owned(),
            undo: false,
        })
    }

    fn now_ms(&self) -> i64 {
        0
    }
}

const NOTES: [(&str, &str); 3] = [("n1", "Bread"), ("n2", "Banana bread"), ("n3", "Taxes")];

struct List;

impl RoomScreen for List {
    fn key(&self) -> String {
        "notes".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        b.read(&notes::TRASH.decl);
        let term = b.ui.search_term().to_lowercase();
        let starred_only = b.ui.is_filtered("filter/starred");
        let shown: Vec<_> = NOTES
            .iter()
            .filter(|(id, title)| {
                title.to_lowercase().contains(&term) && (!starred_only || *id == "n1")
            })
            .collect();
        b.ui.list(shown.iter().map(|(id, _)| (*id).to_owned()));
        let mut rows = Vec::new();
        for (id, title) in shown {
            let row = blocks::row(
                &mut b.sel,
                &format!("row/{id}"),
                title,
                Handler::Open(format!("note/{id}")),
            )
            .swipe(
                &mut b.sel,
                &format!("row/{id}/trash"),
                "Move to trash",
                Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
            );
            rows.push(row.into_block());
        }
        let starred = blocks::menu_item(
            &mut b.sel,
            "filter/starred",
            "Starred",
            Handler::Filter("filter/starred".to_owned()),
        );
        let funnel = blocks::menu(
            "filter",
            vec![blocks::menu_section("Show", vec![starred])],
            &mut b.sel,
        );
        let lens = blocks::action(
            &mut b.sel,
            "lens/week",
            "Week",
            "",
            Handler::Lens("week".to_owned()),
        );
        let mut blocks_out = vec![
            blocks::section(&mut b.sel, "section/lens", "View")
                .trailing(lens)
                .into_block(),
        ];
        blocks_out.extend(rows);
        room(wire::RoomKind::AppPlace, "notes")
            .title("Notes")
            .filter(&mut b.sel, funnel, b.ui)
            .search(&mut b.sel, b.ui, "Search notes")
            .ready(blocks_out)
            .secure()
            .build()
    }
}

struct Note(String);

impl RoomScreen for Note {
    fn key(&self) -> String {
        format!("note/{}", self.0)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&self.0)
            .back(&mut b.sel, "Notes")
            .ready(vec![blocks::prose("A body")])
            .build()
    }
}

struct Twice;

impl RoomScreen for Twice {
    fn key(&self) -> String {
        "twice".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let row = blocks::row(&mut b.sel, "row/1", "One", Handler::Back);
        let again = blocks::row(&mut b.sel, "row/1", "Two", Handler::Back);
        room(wire::RoomKind::PushedPage, "twice")
            .ready(vec![row.into_block(), again.into_block()])
            .build()
    }
}

struct Typing;

impl RoomScreen for Typing {
    fn key(&self) -> String {
        "typing".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "title",
            "Title",
            wire::RoomTextKind::Line,
            "",
            5,
        )
        .build();
        let save = form::explicit(
            &mut b.sel,
            form::Explicit {
                save_label: "Save",
                save: Handler::Tag("save".to_owned()),
                cancel_label: "Cancel",
                cancel: Handler::Back,
                save_enabled: true,
                dirty: false,
                drafted: false,
            },
        );
        room(wire::RoomKind::Editor, "typing")
            .ready(vec![form::form(vec![title], vec![], Save::Explicit(save))])
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        Outcome::say(&format!("tag {tag}"))
    }
}

struct Calendar {
    anchor: String,
}

impl RoomScreen for Calendar {
    fn key(&self) -> String {
        "calendar".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let canvas = blocks::canvas(&mut b.sel, "canvas", "canvas");
        let grid = blocks::calendar_grid(wire::RoomCalendarGrid {
            view: wire::RoomCalendarView::Day as i32,
            anchor_day: self.anchor.clone(),
            create_selector_id: canvas,
            ..wire::RoomCalendarGrid::default()
        });
        room(wire::RoomKind::AppPlace, "calendar")
            .title("Calendar")
            .ready(vec![grid])
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        use wire::room_canvas_event::Kind as C;
        match (tag, input) {
            ("canvas", Input::Canvas(C::CalendarDay(pick))) => {
                self.anchor.clone_from(&pick.day);
                Outcome::default()
            }
            ("canvas", Input::Canvas(C::CalendarCreate(at))) => {
                Outcome::say(&format!("new at {} {}", at.day, at.minute))
            }
            _ => Outcome::refuse("not a canvas event"),
        }
    }
}

fn canvas(selector: &str, kind: wire::room_canvas_event::Kind) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Canvas(wire::RoomCanvasEvent {
            selector_id: selector.to_owned(),
            kind: Some(kind),
        })),
    }
}

fn registry() -> Registry {
    Registry::new()
        .exact("notes", || Box::new(List))
        .exact("twice", || Box::new(Twice))
        .exact("typing", || Box::new(Typing))
        .exact("calendar", || {
            Box::new(Calendar {
                anchor: "2026-11-26".to_owned(),
            })
        })
        .with(Box::new(|key| {
            key.strip_prefix("note/")
                .map(|id| Box::new(Note(id.to_owned())) as Box<dyn RoomScreen>)
        }))
}

struct Harness {
    rooms: Rooms,
    door: Arc<Recorder>,
}

impl Harness {
    fn open(&mut self, key: &str, tab: &str, root: bool) -> Result<Shown, Refusal> {
        self.rooms.open(&*self.door, key, tab, root)
    }

    fn event(&mut self, instance: u64, event: &wire::RoomEvent) -> Result<Option<Shown>, Refusal> {
        self.rooms.event(&*self.door, instance, event)
    }

    fn changed<const N: usize>(&mut self, tables: [&str; N]) -> Vec<Shown> {
        self.rooms.changed(&*self.door, tables)
    }

    fn depth(&self, tab: &str) -> usize {
        self.rooms.depth(tab)
    }
}

fn rooms() -> (Harness, Arc<Recorder>) {
    let door = Arc::new(Recorder::default());
    (
        Harness {
            rooms: Rooms::new(registry()),
            door: door.clone(),
        },
        door,
    )
}

fn tap(id: &str) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: id.to_owned(),
        })),
    }
}

fn type_into(id: &str, seq: u64, text: &str) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
            selector_id: id.to_owned(),
            seq,
            value: Some(wire::room_change::Value::Text(text.to_owned())),
        })),
    }
}

fn scrolled(anchor: &str, fraction: u32) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Scrolled(wire::RoomScrolled {
            anchor_selector_id: anchor.to_owned(),
            anchor_fraction_milli: fraction,
        })),
    }
}

fn ready_blocks(room: &wire::Room) -> &[wire::RoomBlock] {
    match &room.state {
        Some(wire::room::State::Ready(ready)) => &ready.blocks,
        other => panic!("not ready: {other:?}"),
    }
}

fn titles(room: &wire::Room) -> Vec<String> {
    ready_blocks(room)
        .iter()
        .filter_map(|block| match &block.kind {
            Some(wire::room_block::Kind::Row(row)) => Some(row.title.clone()),
            _ => None,
        })
        .collect()
}

fn text_of(room: &wire::Room) -> (String, u64) {
    let Some(wire::room_block::Kind::Form(form)) = &ready_blocks(room)[0].kind else {
        panic!("a form");
    };
    let Some(wire::room_field::Input::Text(text)) = &form.fields[0].input else {
        panic!("a text field");
    };
    (text.value.clone(), text.rev)
}

#[test]
fn a_selector_claimed_twice_refuses_the_room() {
    let (mut rooms, _) = rooms();
    let refusal = rooms.open("twice", "t", true).unwrap_err();
    assert_eq!(refusal, Refusal::Room(RoomError::Repeated("row/1".into())));
    assert_eq!(rooms.depth("t"), 0);
}

#[test]
fn an_unknown_key_and_an_unknown_instance_are_refused() {
    let (mut rooms, _) = rooms();
    assert!(matches!(
        rooms.open("nowhere", "t", true),
        Err(Refusal::NoRoom(_))
    ));
    assert!(matches!(
        rooms.event(9, &tap("x")),
        Err(Refusal::NoInstance(9))
    ));
}

#[test]
fn a_swipe_runs_the_catalogue_action_and_the_status_line_offers_undo() {
    let (mut rooms, door) = rooms();
    let first = rooms.open("notes", "t", true).unwrap();
    let shown = rooms
        .event(first.instance, &tap("row/n1/trash"))
        .unwrap()
        .unwrap();
    assert_eq!(door.acts.lock().unwrap().as_slice(), ["entity.trash"]);
    let line = shown.room.status_line.expect("a status line");
    assert_eq!(line.sentence, "Note moved to trash");
    assert!(!line.action_selector_id.is_empty());
    let after = rooms
        .event(shown.instance, &tap(&line.action_selector_id))
        .unwrap()
        .unwrap();
    assert_eq!(*door.undone.lock().unwrap(), 1);
    assert_eq!(
        after.room.status_line.unwrap().sentence,
        "Back where it was"
    );
}

#[test]
fn a_refused_action_shows_the_cores_sentence_and_nothing_else() {
    let (mut rooms, door) = rooms();
    *door.refuse.lock().unwrap() = true;
    let first = rooms.open("notes", "t", true).unwrap();
    let shown = rooms
        .event(first.instance, &tap("row/n1/trash"))
        .unwrap()
        .unwrap();
    let line = shown.room.status_line.unwrap();
    assert!(line.refused && line.action_selector_id.is_empty());
    assert_eq!(line.sentence, "That note changed. Reload.");
}

#[test]
fn the_text_field_takes_a_rising_seq_and_answers_with_value_and_rev() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("typing", "t", true).unwrap();
    assert_eq!(text_of(&first.room), (String::new(), 0));
    let one = rooms
        .event(first.instance, &type_into("field/title", 1, "Br"))
        .unwrap()
        .unwrap();
    assert_eq!(text_of(&one.room), ("Br".to_owned(), 1));
    let stale = rooms
        .event(first.instance, &type_into("field/title", 1, "Nope"))
        .unwrap();
    assert!(stale.is_none(), "a repeated seq changes nothing");
    let cut = rooms
        .event(first.instance, &type_into("field/title", 4, "Bread!!"))
        .unwrap()
        .unwrap();
    assert_eq!(
        text_of(&cut.room),
        ("Bread".to_owned(), 2),
        "Rust keeps its own value and the shell adopts it"
    );
}

#[test]
fn a_tag_event_reaches_the_screen_and_its_words_land_on_the_status_line() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("typing", "t", true).unwrap();
    let shown = rooms
        .event(first.instance, &tap("form/save"))
        .unwrap()
        .unwrap();
    assert_eq!(shown.room.status_line.unwrap().sentence, "tag save");
}

#[test]
fn keep_my_place_saves_on_push_and_restores_once_on_pop() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("notes", "t", true).unwrap();
    let id = first.instance;
    assert!(rooms.event(id, &scrolled("row/n2", 420)).unwrap().is_none());
    rooms.event(id, &tap("search")).unwrap();
    let typed = rooms
        .event(id, &type_into("search", 1, "bread"))
        .unwrap()
        .unwrap();
    assert_eq!(titles(&typed.room), ["Bread", "Banana bread"]);
    rooms.event(id, &tap("filter/starred")).unwrap();
    rooms.event(id, &tap("lens/week")).unwrap();
    let pushed = rooms.event(id, &tap("row/n1")).unwrap().unwrap();
    assert_eq!(pushed.depth, 2);
    assert_eq!(pushed.movement, centraid_screens::room::Move::Push);
    assert!(pushed.room.restore.is_none());

    let popped = rooms.event(pushed.instance, &tap("back")).unwrap().unwrap();
    assert_eq!(popped.movement, centraid_screens::room::Move::Pop);
    assert_eq!(popped.depth, 1);
    let place = popped
        .room
        .restore
        .clone()
        .expect("restore on the first ready after a pop");
    assert_eq!(place.anchor_selector_id, "row/n2");
    assert_eq!(place.anchor_fraction_milli, 420);
    assert_eq!(place.search_term, "bread");
    assert_eq!(place.filter_selector_ids, ["filter/starred"]);
    assert_eq!(
        titles(&popped.room),
        ["Bread"],
        "the answer is the same filtered, searched list"
    );

    let reloaded = rooms.changed(["entity"]);
    assert_eq!(reloaded.len(), 1);
    assert!(
        reloaded[0].room.restore.is_none(),
        "a reload never re-sends restore"
    );
}

#[test]
fn a_commit_reloads_only_the_rooms_whose_reads_it_reaches() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("notes", "t", true).unwrap();
    assert!(rooms.changed(["person", "event"]).is_empty());
    let reloaded = rooms.changed(["event", "entity"]);
    assert_eq!(reloaded.len(), 1);
    assert_eq!(reloaded[0].instance, first.instance);
    assert_eq!(reloaded[0].movement, centraid_screens::room::Move::Reload);
}

#[test]
fn a_covered_room_is_not_reloaded_but_is_built_again_when_uncovered() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("notes", "t", true).unwrap();
    let child = rooms
        .event(first.instance, &tap("row/n3"))
        .unwrap()
        .unwrap();
    assert!(
        rooms.changed(["entity"]).is_empty(),
        "the child reads nothing"
    );
    let back = rooms.event(child.instance, &tap("back")).unwrap().unwrap();
    assert_eq!(back.instance, first.instance);
}

#[test]
fn a_tap_on_a_stale_selector_changes_nothing() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("notes", "t", true).unwrap();
    assert!(
        rooms
            .event(first.instance, &tap("row/gone"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_new_root_replaces_the_stack() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("notes", "t", true).unwrap();
    rooms.event(first.instance, &tap("row/n1")).unwrap();
    assert_eq!(rooms.depth("t"), 2);
    let again = rooms.open("notes", "t", true).unwrap();
    assert_eq!(again.depth, 1);
    assert_eq!(again.movement, centraid_screens::room::Move::Replace);
}

#[test]
fn the_list_room_reads_as_text() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("notes", "t", true).unwrap();
    snapshot::assert_room("notes_list", &first.room);
}

#[test]
fn a_canvas_event_is_routed_to_its_screen_with_its_typed_payload() {
    let (mut rooms, _) = rooms();
    let first = rooms.open("calendar", "t", true).unwrap();
    let picked = rooms
        .event(
            first.instance,
            &canvas(
                "canvas",
                wire::room_canvas_event::Kind::CalendarDay(wire::RoomCalendarPickDay {
                    day: "2026-12-01".into(),
                }),
            ),
        )
        .unwrap()
        .unwrap();
    let Some(wire::room::State::Ready(ready)) = &picked.room.state else {
        panic!("ready");
    };
    let Some(wire::room_block::Kind::CalendarGrid(grid)) = &ready.blocks[0].kind else {
        panic!("a calendar grid");
    };
    assert_eq!(grid.anchor_day, "2026-12-01");

    let created = rooms
        .event(
            first.instance,
            &canvas(
                "canvas",
                wire::room_canvas_event::Kind::CalendarCreate(wire::RoomCalendarCreateAt {
                    day: "2026-12-02".into(),
                    minute: 540,
                    all_day: false,
                }),
            ),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        created.room.status_line.unwrap().sentence,
        "new at 2026-12-02 540"
    );

    let stale = rooms
        .event(
            first.instance,
            &canvas(
                "not-a-canvas",
                wire::room_canvas_event::Kind::ChartScrub(wire::RoomChartScrubbed {
                    point_id: "p".into(),
                }),
            ),
        )
        .unwrap();
    assert!(
        stale.is_none(),
        "a selector the room does not hold changes nothing"
    );
}
