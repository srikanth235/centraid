//! Following a phone store over a real core, played as a shell plays it (app-plane §16): a room's
//! tap enrols, triggers carry no data, the shell answers each `store_read` with what the OS said.
//! Every assertion counts reads and permission asks; none measures time.

use std::sync::Arc;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("follow")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("it founds");
    centraid_screens::attach(&handle);
    handle
}

struct Shell<'a> {
    handle: &'a Handle,
    reads: u32,
    permission_asks: u32,
    watches: Vec<(String, bool)>,
    settings: Vec<String>,
    forgotten: Vec<String>,
    room: Option<wire::RoomShown>,
}

impl<'a> Shell<'a> {
    fn new(handle: &'a Handle) -> Self {
        Self {
            handle,
            reads: 0,
            permission_asks: 0,
            watches: Vec::new(),
            settings: Vec::new(),
            forgotten: Vec::new(),
            room: None,
        }
    }

    fn call(&self, request: wire::FollowRequest) -> wire::FollowResponse {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Follow(request)),
            })
            .expect("the follow request answers")
            .kind
        {
            Some(wire::response::Kind::Follow(answer)) => answer,
            other => panic!("not a follow answer: {other:?}"),
        }
    }

    fn verb(&self, verb: wire::FollowVerb, system: &str) -> wire::FollowResponse {
        self.call(wire::FollowRequest {
            verb: verb as i32,
            system: system.to_owned(),
            ..Default::default()
        })
    }

    /// Everything the core pushed since the last look: the reads asked for, in order.
    fn pump(&mut self) -> Vec<wire::ShellEffect> {
        use wire::shell_effect::Kind as K;
        let mut reads = Vec::new();
        while let Ok(Some(event)) = self.handle.next_event(Duration::from_millis(20)) {
            match event.kind {
                Some(wire::event::Kind::Effect(effect)) => match effect.kind.clone() {
                    Some(K::StoreRead(read)) => {
                        self.reads += 1;
                        self.permission_asks += u32::from(read.ask_permission);
                        reads.push(effect);
                    }
                    Some(K::PhoneWatch(watch)) => self.watches.push((watch.system, watch.on)),
                    Some(K::OpenSettings(open)) => self.settings.push(open.system),
                    Some(K::ReleaseGrant(release)) => self.forgotten.push(release.r#ref),
                    other => panic!("an effect the follower never asks: {other:?}"),
                },
                Some(wire::event::Kind::Room(shown)) => self.room = Some(*shown),
                _ => {}
            }
        }
        reads
    }

    fn answer(
        &self,
        ask: &wire::ShellEffect,
        grant: wire::FollowGrant,
        input: serde_json::Value,
    ) -> wire::FollowResponse {
        self.call(wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: read_of(ask).system.clone(),
            ask_id: ask.effect_id,
            grant: grant as i32,
            input_json: if input.is_null() {
                String::new()
            } else {
                input.to_string()
            },
            ..Default::default()
        })
    }

    fn tap(&mut self, label: &str) {
        let shown = self.room.clone().expect("a room is open");
        let id = more_rows(shown.room.as_ref().unwrap())
            .into_iter()
            .find(|(text, _)| text == label)
            .unwrap_or_else(|| panic!("no More row `{label}` in {:?}", self.labels()))
            .1;
        let again = room_call(
            self.handle,
            wire::room_request::Kind::Send(wire::RoomSend {
                instance: shown.instance,
                event: Some(wire::RoomEvent {
                    kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                        selector_id: id,
                    })),
                }),
            }),
        );
        if let Some(last) = again.into_iter().last() {
            self.room = Some(last);
        }
    }

    fn tap_id(&mut self, id: &str) {
        let shown = self.room.clone().expect("a room is open");
        let again = room_call(
            self.handle,
            wire::room_request::Kind::Send(wire::RoomSend {
                instance: shown.instance,
                event: Some(wire::RoomEvent {
                    kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                        selector_id: id.to_owned(),
                    })),
                }),
            }),
        );
        if let Some(last) = again.into_iter().last() {
            self.room = Some(last);
        }
    }

    fn labels(&self) -> Vec<String> {
        self.room
            .as_ref()
            .and_then(|shown| shown.room.as_ref())
            .map(|room| {
                more_rows(room)
                    .into_iter()
                    .map(|(label, _)| label)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn open(&mut self, key: &str) {
        self.room = Some(
            room_call(
                self.handle,
                wire::room_request::Kind::Open(wire::RoomOpen {
                    key: key.to_owned(),
                    tab: key.to_owned(),
                    root: true,
                    ..Default::default()
                }),
            )
            .remove(0),
        );
    }

    fn rendered(&self) -> String {
        snapshot::render(self.room.as_ref().unwrap().room.as_ref().unwrap())
    }
}

fn read_of(effect: &wire::ShellEffect) -> &wire::ShellStoreRead {
    match &effect.kind {
        Some(wire::shell_effect::Kind::StoreRead(read)) => read,
        other => panic!("not a read: {other:?}"),
    }
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    match handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("the room call answers")
        .kind
    {
        Some(wire::response::Kind::Room(answer)) => answer.shown,
        other => panic!("not a room answer: {other:?}"),
    }
}

fn more_rows(room: &wire::Room) -> Vec<(String, String)> {
    room.band
        .as_ref()
        .and_then(|band| band.more.as_ref())
        .map(|menu| {
            menu.sections
                .iter()
                .flat_map(|section| section.items.iter())
                .map(|item| (item.label.clone(), item.selector_id.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn contacts(names: &[(&str, &str)]) -> serde_json::Value {
    json!({
        "origin": { "ref": "phone", "label": "Phone" },
        "complete": true,
        "records": names.iter().map(|(id, name)| json!({
            "external_id": id, "fields": { "title": name } })).collect::<Vec<_>>(),
    })
}

fn people_enrolled(shell: &mut Shell<'_>) {
    shell.open("people");
    shell.tap("Follow Contacts");
    let asks = shell.pump();
    assert_eq!(asks.len(), 1);
    shell.answer(
        &asks[0],
        wire::FollowGrant::Granted,
        contacts(&[("c1", "Grace Hopper"), ("c2", "Alan Turing")]),
    );
    shell.pump();
}

#[test]
fn a_tap_asks_the_phone_once_and_a_granted_read_is_followed_and_said() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    shell.open("people");
    assert!(shell.labels().contains(&"Follow Contacts".to_owned()));

    shell.tap("Follow Contacts");
    let asks = shell.pump();
    assert_eq!(asks.len(), 1, "one tap, one ask");
    assert!(
        read_of(&asks[0]).ask_permission,
        "the member's tap is the one place the OS is asked"
    );
    assert_eq!((shell.reads, shell.permission_asks), (1, 1));

    let done = shell.answer(
        &asks[0],
        wire::FollowGrant::Granted,
        contacts(&[("c1", "Grace Hopper"), ("c2", "Alan Turing")]),
    );
    assert!(!done.declined && !done.stale, "{done:?}");
    shell.pump();
    assert_eq!(shell.watches, [("contacts".to_owned(), true)]);

    assert!(
        shell.labels().contains(&"Following Contacts".to_owned()),
        "{:?}",
        shell.labels()
    );
    assert!(
        shell
            .labels()
            .contains(&"Stop following Contacts".to_owned())
    );
    let status = shell
        .verb(wire::FollowVerb::Status, "contacts")
        .status
        .unwrap();
    assert!(
        status.enrolled && status.read && status.count == 2,
        "{status:?}"
    );

    let people = open_text(&handle, "people");
    assert!(
        people.contains("Grace Hopper") && people.contains("Alan Turing"),
        "{people}"
    );
}

fn open_text(handle: &Handle, key: &str) -> String {
    let shown = room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: key.to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .remove(0);
    snapshot::render(shown.room.as_ref().unwrap())
}

#[test]
fn background_triggers_read_without_asking_and_a_store_not_enrolled_is_never_read() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);

    assert_eq!(
        shell.verb(wire::FollowVerb::Trigger, "").asked,
        0,
        "nothing enrolled, nothing read"
    );
    assert!(shell.pump().is_empty());
    assert_eq!(shell.reads, 0);

    people_enrolled(&mut shell);
    let (reads, asked_before) = (shell.reads, shell.permission_asks);
    for _ in 0..3 {
        assert_eq!(
            shell.verb(wire::FollowVerb::Trigger, "").asked,
            1,
            "only the enrolled store"
        );
        let asks = shell.pump();
        assert_eq!(asks.len(), 1);
        assert!(
            !read_of(&asks[0]).ask_permission,
            "a background pass never asks the OS"
        );
        shell.answer(
            &asks[0],
            wire::FollowGrant::Granted,
            contacts(&[("c1", "Grace Hopper")]),
        );
    }
    assert_eq!(shell.reads, reads + 3);
    assert_eq!(
        shell.permission_asks, asked_before,
        "background passes asked 0 times"
    );
}

#[test]
fn a_refused_permission_says_so_makes_no_reads_after_and_offers_settings() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let handle = &handle;
    let mut shell = Shell::new(&handle);
    shell.open("people");
    shell.tap("Follow Contacts");
    let asks = shell.pump();
    shell.answer(
        &asks[0],
        wire::FollowGrant::Refused,
        serde_json::Value::Null,
    );
    shell.pump();

    let labels = shell.labels();
    assert!(labels.contains(&"Contacts is off".to_owned()), "{labels:?}");
    assert!(
        labels.contains(&"Follow Contacts".to_owned()),
        "a refusal can be tried again: {labels:?}"
    );
    let reads = shell.reads;
    for _ in 0..3 {
        assert_eq!(shell.verb(wire::FollowVerb::Trigger, "").asked, 0);
    }
    assert!(shell.pump().is_empty());
    assert_eq!(shell.reads, reads, "a refusal makes 0 reads after");

    let shown = shell.room.clone().unwrap();
    let id = more_rows(shown.room.as_ref().unwrap())
        .into_iter()
        .find(|(label, _)| label == "Contacts is off")
        .unwrap()
        .1;
    let send = |kind: wire::room_event::Kind| match handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(wire::room_request::Kind::Send(wire::RoomSend {
                    instance: shown.instance,
                    event: Some(wire::RoomEvent { kind: Some(kind) }),
                })),
            })),
        })
        .unwrap()
        .kind
    {
        Some(wire::response::Kind::Room(answer)) => answer,
        other => panic!("{other:?}"),
    };
    let answer = send(wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: id,
    }));
    assert_eq!(
        answer.effects.len(),
        1,
        "the tap asks the shell for one thing"
    );
    let effect = &answer.effects[0];
    assert!(matches!(
        &effect.kind,
        Some(wire::shell_effect::Kind::OpenSettings(open)) if open.system == "contacts"
    ));
    let back = send(wire::room_event::Kind::EffectResult(
        wire::ShellEffectResult {
            effect_id: effect.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Done(wire::ShellDone {})),
        },
    ));
    assert!(
        back.effects.is_empty(),
        "the answer returns to the room that asked"
    );

    shell.tap("Follow Contacts");
    let again = shell.pump();
    assert_eq!(again.len(), 1);
    assert!(
        read_of(&again[0]).ask_permission,
        "only the member's tap asks again"
    );
    assert_eq!(shell.permission_asks, 2);
}

#[test]
fn a_grant_the_member_takes_back_later_ends_reading_until_the_next_tap() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    people_enrolled(&mut shell);

    shell.verb(wire::FollowVerb::Trigger, "contacts");
    let asks = shell.pump();
    shell.answer(
        &asks[0],
        wire::FollowGrant::Refused,
        serde_json::Value::Null,
    );
    let reads = shell.reads;
    assert_eq!(shell.verb(wire::FollowVerb::Trigger, "").asked, 0);
    shell.pump();
    assert_eq!(shell.reads, reads);
    let status = shell
        .verb(wire::FollowVerb::Status, "contacts")
        .status
        .unwrap();
    assert_eq!(status.blocked, wire::FollowGrant::Refused as i32);
}

#[test]
fn triggers_during_a_pass_queue_exactly_one_more_and_a_stale_answer_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    people_enrolled(&mut shell);

    assert_eq!(shell.verb(wire::FollowVerb::Trigger, "contacts").asked, 1);
    let first = shell.pump().remove(0);
    assert_eq!(
        shell.verb(wire::FollowVerb::Trigger, "contacts").asked,
        0,
        "joined the one in flight"
    );
    assert!(shell.pump().is_empty());

    let done = shell.answer(
        &first,
        wire::FollowGrant::Granted,
        contacts(&[("c1", "Grace Hopper")]),
    );
    assert_eq!(
        done.asked, 1,
        "the queued trigger runs once after the answer"
    );
    let second = shell.pump().remove(0);
    let late = shell.answer(&first, wire::FollowGrant::Granted, contacts(&[]));
    assert!(
        late.stale,
        "an answer to an ask that is no longer current is ignored"
    );
    let done = shell.answer(
        &second,
        wire::FollowGrant::Granted,
        contacts(&[("c1", "Grace Hopper")]),
    );
    assert_eq!(done.asked, 0, "no more than one was queued");
    assert!(shell.pump().is_empty());
}

#[test]
fn a_shell_that_never_answers_is_asked_again_on_the_next_trigger_after_the_queued_one() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    people_enrolled(&mut shell);

    assert_eq!(shell.verb(wire::FollowVerb::Trigger, "contacts").asked, 1);
    assert_eq!(shell.verb(wire::FollowVerb::Trigger, "contacts").asked, 0);
    assert_eq!(
        shell.verb(wire::FollowVerb::Trigger, "contacts").asked,
        1,
        "the third trigger replaces an ask nobody answered"
    );
}

#[test]
fn stopping_keeps_what_was_read_forgets_the_enrolment_and_ends_passes() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    people_enrolled(&mut shell);

    shell.tap("Stop following Contacts");
    let sheet = shell.rendered();
    assert!(
        sheet.contains("Stop following Contacts?") && sheet.contains("What it already added stays"),
        "a stop asks first, in words that say nothing is deleted:\n{sheet}"
    );
    assert_eq!(
        shell
            .verb(wire::FollowVerb::Status, "contacts")
            .status
            .unwrap()
            .enrolled,
        true
    );
    shell.tap_id("confirm/no");
    assert!(
        shell
            .verb(wire::FollowVerb::Status, "contacts")
            .status
            .unwrap()
            .enrolled,
        "cancel stops nothing"
    );
    shell.tap("Stop following Contacts");
    shell.tap_id("confirm/yes");
    shell.pump();
    assert_eq!(shell.watches.last(), Some(&("contacts".to_owned(), false)));
    assert!(
        shell.labels().contains(&"Follow Contacts".to_owned()),
        "{:?}",
        shell.labels()
    );
    assert_eq!(shell.verb(wire::FollowVerb::Trigger, "").asked, 0);
    assert!(
        shell.pump().is_empty(),
        "a stopped store is never read again"
    );

    let people = open_text(&handle, "people");
    assert!(
        people.contains("Grace Hopper") && people.contains("Alan Turing"),
        "stopping deletes nothing: {people}"
    );
}

#[test]
fn health_resumes_from_the_cursor_the_origin_holds_and_never_asks_in_a_pass() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    shell.open("health");
    shell.tap("Follow Health");
    let first = shell.pump().remove(0);
    assert!(
        read_of(&first).ask_permission && read_of(&first).cursor.is_empty(),
        "a first read is complete"
    );
    assert_eq!(read_of(&first).days_back, 365);
    assert_eq!(read_of(&first).workouts_since_ms, NOW - 90 * 86_400_000);

    let snapshot = |cursor: &str| {
        json!({ "workouts": {
            "origin": { "ref": "store:apple-health", "label": "Apple Health", "cursor": cursor },
            "records": [{ "external_id": "w:1", "fields": {
                "kind": "run", "starts": "2026-03-04T07:00:00Z", "ends": "2026-03-04T07:45:00Z",
                "recorded_by": "Watch", "moving_s": 2700, "distance_m": 5234.5 } }],
            "complete": false } })
    };
    let done = shell.answer(&first, wire::FollowGrant::Granted, snapshot("anchors-1"));
    assert!(!done.declined, "{done:?}");
    shell.pump();

    shell.verb(wire::FollowVerb::Trigger, "health");
    let second = shell.pump().remove(0);
    assert!(!read_of(&second).ask_permission);
    assert_eq!(
        read_of(&second).cursor,
        "anchors-1",
        "the next read resumes where the vault says it stopped"
    );
    shell.answer(&second, wire::FollowGrant::Granted, snapshot("anchors-2"));
    shell.pump();
    shell.verb(wire::FollowVerb::Trigger, "health");
    assert_eq!(read_of(&shell.pump().remove(0)).cursor, "anchors-2");
    assert_eq!(shell.permission_asks, 1);
}

#[test]
fn reminders_that_the_phone_does_not_have_say_so_and_are_never_read() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    shell.open("reminders");
    shell.tap("Follow Reminders");
    let asks = shell.pump();
    shell.answer(
        &asks[0],
        wire::FollowGrant::Unavailable,
        serde_json::Value::Null,
    );
    shell.pump();
    assert!(
        shell
            .labels()
            .contains(&"Reminders isn’t on this phone".to_owned()),
        "{:?}",
        shell.labels()
    );
    assert_eq!(shell.verb(wire::FollowVerb::Trigger, "").asked, 0);
}

#[test]
fn the_more_sheet_of_each_owning_app_offers_its_store() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    for (key, row) in [
        ("people", "Follow Contacts"),
        ("calendar", "Follow Calendars"),
        ("reminders", "Follow Reminders"),
        ("docs", "Follow a folder"),
        ("health", "Follow Health"),
        ("photos", "Follow Camera roll"),
    ] {
        shell.open(key);
        assert!(
            shell.labels().contains(&row.to_owned()),
            "{key}: {:?}\n{}",
            shell.labels(),
            shell.rendered()
        );
    }
}

#[test]
fn a_followed_folder_is_stopped_from_its_page_and_its_grant_is_released() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    shell.open("docs");
    shell.tap("Follow a folder");
    let ask = shell.pump().remove(0);
    assert!(
        read_of(&ask).ask_permission,
        "the picker is the ask, and only the tap opens it"
    );
    let done = shell.answer(
        &ask,
        wire::FollowGrant::Granted,
        json!({ "origin": { "ref": "/Documents/Taxes", "label": "Taxes" }, "records": [], "complete": true }),
    );
    assert!(!done.declined, "{done:?}");
    shell.pump();
    assert_eq!(
        shell.verb(wire::FollowVerb::Trigger, "").asked,
        1,
        "the folder is read on a trigger"
    );
    let pass = shell.pump().remove(0);
    assert!(!read_of(&pass).ask_permission);
    shell.answer(&pass, wire::FollowGrant::Granted, json!({ "origin": { "ref": "/Documents/Taxes", "label": "Taxes" }, "records": [], "complete": true }));

    shell.open("docs/followed");
    assert!(shell.rendered().contains("Taxes"), "{}", shell.rendered());
    shell.open("follow/stop/files:/Documents/Taxes");
    shell.tap_id("confirm/yes");
    shell.pump();
    assert_eq!(
        shell.forgotten,
        ["/Documents/Taxes"],
        "the shell releases the folder's grant"
    );
    assert_eq!(
        shell.verb(wire::FollowVerb::Trigger, "").asked,
        0,
        "no folder left, no pass"
    );
}

#[test]
fn a_first_open_import_enrols_through_the_one_door_and_asks_once() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let mut shell = Shell::new(&handle);
    shell.open("people");
    shell.tap_id("first/people/action");
    let asks = shell.pump();
    assert_eq!(asks.len(), 1, "one tap, one read");
    assert!(read_of(&asks[0]).ask_permission);
    assert_eq!(read_of(&asks[0]).system, "contacts");
    shell.answer(
        &asks[0],
        wire::FollowGrant::Refused,
        serde_json::Value::Null,
    );
    shell.pump();
    shell.open("people");
    assert!(
        shell.rendered().contains("Open Settings"),
        "{}",
        shell.rendered()
    );
}
