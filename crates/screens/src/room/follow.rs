//! Follow controls for phone stores. The core owns reader and permission decisions; rooms reload
//! when a follow pass or refusal changes state.

use centraid_api_proto::core_v1 as wire;

use super::blocks::{self, Confirm};
use super::door::Door;
use super::frame::room;
use super::screen::{Build, Event, Input, Nav, Outcome, Registry, RoomScreen, Status};
use super::selector::{Act, Handler, Sel};
use crate::kit::permission::{self, Resource, State};
use crate::strings::{Locale, fill, follow as words, shared};

const EN: Locale = Locale::En;

/// Show only fields the phone stated that differ from the member's current values.
pub fn phone_says(
    sel: &mut Sel,
    door: &dyn Door,
    entity_id: &str,
    source: &centraid_domain::apps::entity::PhoneDifferenceRow,
    current: &[(&str, String, serde_json::Value)],
) -> Option<wire::RoomBlock> {
    let stated: serde_json::Value = serde_json::from_str(&source.stated).ok()?;
    let mut fields = Vec::new();
    for (key, label, mine) in current {
        let title_value = if *key == "title" {
            source
                .stated_title
                .as_ref()
                .map(|title| serde_json::Value::String(title.clone()))
        } else {
            None
        };
        let Some(value) = (if *key == "title" {
            title_value.as_ref()
        } else {
            stated.get(*key)
        }) else {
            continue;
        };
        if comparable(value) == comparable(mine) {
            continue;
        }
        let phone = display_value(door, key, value);
        let held = display_value(door, key, mine);
        fields.push(blocks::says_field(
            sel,
            &format!("phone-says/{}/{}", source.id, key),
            label,
            &phone,
            &held,
            Handler::Act(Act::new(
                "follow.take_stated",
                serde_json::json!({ "entity": entity_id, "field": key, "origin": source.origin_id }),
            )),
        ));
    }
    (!fields.is_empty()).then(|| {
        blocks::says(
            wire::RoomSaysSource::Phone,
            &shared::phone_says(EN),
            fields,
            &shared::take_phone_value(EN),
        )
    })
}

fn comparable(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Array(values) => {
            let mut stable: Vec<String> = values.iter().map(comparable).collect();
            stable.sort();
            serde_json::to_string(&stable).unwrap_or_default()
        }
        serde_json::Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn display_value(door: &dyn Door, field: &str, value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => shared::phone_value_none(EN),
        Value::Array(items) if items.is_empty() => shared::phone_value_none(EN),
        Value::Array(items) => items
            .iter()
            .map(|item| display_item(door, field, item))
            .collect::<Vec<_>>()
            .join(", "),
        Value::String(text) => display_text(door, field, text),
        other => other.to_string(),
    }
}

fn display_item(door: &dyn Door, field: &str, item: &serde_json::Value) -> String {
    use serde_json::Value;
    if let Some(object) = item.as_object() {
        if matches!(field, "points" | "dates") {
            let label = object
                .get("label")
                .and_then(Value::as_str)
                .or_else(|| object.get("kind").and_then(Value::as_str));
            let value = object
                .get("value")
                .or_else(|| object.get("date"))
                .map(|value| {
                    display_value(door, if field == "dates" { "due" } else { field }, value)
                })
                .unwrap_or_default();
            return match (label, value.is_empty()) {
                (Some(label), false) => format!("{label}: {value}"),
                (Some(label), true) => label.to_owned(),
                (None, _) => value,
            };
        }
        if field == "attendees" {
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let email = object
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let status = object
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let role = object
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return [name, email, status, role]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
        }
    }
    if field == "reminders"
        && let Some(minutes) = item.as_i64()
    {
        return if minutes == 0 {
            "At the time".to_owned()
        } else {
            format!("{minutes} min before")
        };
    }
    display_value(door, field, item)
}

fn display_text(door: &dyn Door, field: &str, text: &str) -> String {
    if matches!(field, "starts" | "ends" | "due") {
        if crate::kit::civil::epoch_day_of(text).is_some() {
            return crate::kit::civil::short_day(EN, text);
        }
        if let Some(local) = door.wall_time(text) {
            return local;
        }
    }
    text.to_owned()
}

pub fn status(door: &dyn Door, system: &str) -> Option<wire::FollowStatus> {
    let request = wire::Request {
        kind: Some(wire::request::Kind::Follow(wire::FollowRequest {
            verb: wire::FollowVerb::Status as i32,
            system: system.to_owned(),
            ..Default::default()
        })),
    };
    match door.call(&request).ok()?.kind {
        Some(wire::response::Kind::Follow(answer)) => answer.status,
        _ => None,
    }
}

/// The sentence a partial or doubted pass leaves, in the words every store shares.
#[must_use]
pub fn partial(status: &wire::FollowStatus, system: &str) -> Option<String> {
    if status.doubted > 0 {
        Some(fill(
            &words::doubted_status(EN),
            &[("source", &source(system))],
        ))
    } else if status.incomplete {
        Some(fill(
            &words::incomplete_status(EN),
            &[("source", &source(system))],
        ))
    } else {
        None
    }
}

fn blocked_state(grant: wire::FollowGrant) -> Option<State> {
    match grant {
        wire::FollowGrant::Refused => Some(State::Refused),
        wire::FollowGrant::Restricted => Some(State::Restricted),
        _ => None,
    }
}

/// The rows a More sheet holds for `system`, and the watch that redraws them.
pub fn items(b: &mut Build<'_>, system: &str) -> Vec<wire::RoomMenuItem> {
    b.watch(&[WATCH]);
    let status = status(b.door, system).unwrap_or_default();
    let name = store(system);
    let slug = system.replace('_', "-");
    let with_store = |template: String| fill(&template, &[("store", &name)]);
    let tag = |verb: &str| Handler::Tag(format!("follow:{verb}:{system}"));
    let mut rows = Vec::new();
    let blocked = wire::FollowGrant::try_from(status.blocked).unwrap_or_default();
    if blocked == wire::FollowGrant::Unavailable {
        let mut row = blocks::menu_item(
            &mut b.sel,
            &format!("more/follow-{slug}"),
            &with_store(words::unavailable_row(EN)),
            tag("note"),
        );
        row.secondary = String::new();
        rows.push(row);
    } else if let Some(state) = blocked_state(blocked) {
        let mut row = blocks::menu_item(
            &mut b.sel,
            &format!("more/follow-{slug}"),
            &with_store(words::off_row(EN)),
            if state == State::Refused {
                tag("settings")
            } else {
                tag("note")
            },
        );
        row.secondary = permission::says(EN, resource(system), state);
        rows.push(row);
        if state == State::Refused {
            rows.push(blocks::menu_item(
                &mut b.sel,
                &format!("more/follow-{slug}-again"),
                &if system == "files" {
                    words::follow_files_row(EN)
                } else {
                    with_store(words::follow_row(EN))
                },
                tag("enrol"),
            ));
        }
    } else if status.enrolled {
        let label = if system == "files" {
            words::following_files_row(EN)
        } else {
            with_store(words::following_row(EN))
        };
        let mut row = blocks::menu_item(
            &mut b.sel,
            &format!("more/follow-{slug}"),
            &label,
            tag("note"),
        );
        row.secondary = partial(&status, system).unwrap_or_else(|| words::following_meta(EN));
        rows.push(row);
        if system != "files" {
            let mut stop = blocks::menu_item(
                &mut b.sel,
                &format!("more/follow-{slug}-stop"),
                &with_store(words::stop_row(EN)),
                Handler::Open(format!("follow/stop/{system}")),
            );
            stop.destructive = true;
            rows.push(stop);
        }
    } else {
        rows.push(blocks::menu_item(
            &mut b.sel,
            &format!("more/follow-{slug}"),
            &if system == "files" {
                words::follow_files_row(EN)
            } else {
                with_store(words::follow_row(EN))
            },
            tag("enrol"),
        ));
    }
    rows
}

fn ask(door: &dyn Door, verb: wire::FollowVerb, system: &str) -> Result<(), super::door::Refused> {
    door.call(&wire::Request {
        kind: Some(wire::request::Kind::Follow(wire::FollowRequest {
            verb: verb as i32,
            system: system.to_owned(),
            ..Default::default()
        })),
    })
    .map(|_| ())
}

/// A tap on one of these rows. `None` when the tag is not a follow row's.
pub fn handle(e: &mut Event<'_>, tag: &str) -> Option<Outcome> {
    let mut parts = tag.strip_prefix("follow:")?.splitn(2, ':');
    let (verb, system) = (parts.next()?, parts.next()?);
    let outcome = match verb {
        "enrol" => ask(e.door, wire::FollowVerb::Enrol, system).map_or_else(
            |refused| Outcome::refuse(&refused.0),
            |()| Outcome::default(),
        ),
        "settings" => Outcome::effect(
            &format!("follow:settled:{system}"),
            wire::shell_effect::Kind::OpenSettings(wire::ShellOpenSettings {
                system: system.to_owned(),
            }),
        ),
        "settled" => Outcome::default(),
        "note" => {
            let status = status(e.door, system).unwrap_or_default();
            let blocked = wire::FollowGrant::try_from(status.blocked).unwrap_or_default();
            match (partial(&status, system), blocked_state(blocked)) {
                (Some(sentence), _) => Outcome::say(&sentence),
                (None, Some(state)) => Outcome::say(&permission::says(EN, resource(system), state)),
                _ if status.asking => Outcome::say(&words::asking_status(EN)),
                _ => Outcome::default(),
            }
        }
        _ => return None,
    };
    Some(outcome)
}

/// The confirm a stop asks first: `follow/stop/<store>`, or `follow/stop/files:<ref>` for one folder.
#[must_use]
pub fn registry() -> Registry {
    Registry::new().with(Box::new(|key| {
        let rest = key.strip_prefix("follow/stop/")?;
        let (system, origin) = match rest.split_once(':') {
            Some((system, origin)) => (system, Some(origin.to_owned())),
            None => (rest, None),
        };
        Some(Box::new(StopConfirm {
            system: system.to_owned(),
            origin,
        }) as Box<dyn RoomScreen>)
    }))
}

struct StopConfirm {
    system: String,
    origin: Option<String>,
}

impl RoomScreen for StopConfirm {
    fn key(&self) -> String {
        match &self.origin {
            Some(origin) => format!("follow/stop/{}:{origin}", self.system),
            None => format!("follow/stop/{}", self.system),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let holes = [
            ("store", store(&self.system)),
            ("source", source(&self.system)),
        ];
        let holes = [
            (holes[0].0, holes[0].1.as_str()),
            (holes[1].0, holes[1].1.as_str()),
        ];
        let title = fill(&words::stop_title(EN), &holes);
        let body = fill(&words::stop_body(EN), &holes);
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &body,
                warning: "",
                confirm_label: &words::stop_confirm(EN),
                confirm: Handler::Tag("stop:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag != "stop:confirm" {
            return Outcome::default();
        }
        let request = wire::Request {
            kind: Some(wire::request::Kind::Follow(wire::FollowRequest {
                verb: wire::FollowVerb::Stop as i32,
                system: self.system.clone(),
                input_json: self
                    .origin
                    .as_ref()
                    .map(|origin| serde_json::json!({ "ref": origin }).to_string())
                    .unwrap_or_default(),
                ..Default::default()
            })),
        };
        match e.door.call(&request) {
            Ok(_) => Outcome {
                nav: Nav::Pop,
                status: Some(Status {
                    sentence: fill(
                        &words::stopped_status(EN),
                        &[("store", &store(&self.system))],
                    ),
                    undo: false,
                    refused: false,
                }),
                ..Outcome::default()
            },
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

pub const WATCH: &str = "follow";

fn resource(system: &str) -> Resource {
    match system {
        "contacts" => Resource::Contacts,
        "calendar" => Resource::Calendar,
        "reminders" => Resource::Reminders,
        "health" => Resource::Health,
        "files" => Resource::Files,
        _ => Resource::Photos,
    }
}

fn store(system: &str) -> String {
    match system {
        "contacts" => words::store_contacts(EN),
        "calendar" => words::store_calendar(EN),
        "reminders" => words::store_reminders(EN),
        "health" => words::store_health(EN),
        "files" => words::store_files(EN),
        _ => words::store_camera_roll(EN),
    }
}

fn source(system: &str) -> String {
    match system {
        "contacts" => words::source_contacts(EN),
        "calendar" => words::source_calendar(EN),
        "reminders" => words::source_reminders(EN),
        "health" => words::source_health(EN),
        "files" => words::source_files(EN),
        _ => words::source_camera_roll(EN),
    }
}

#[cfg(test)]
mod tests {
    use super::super::selector::Act;
    use super::phone_says;
    use crate::room::door::{Done, Refused};
    use crate::room::selector::Sel;
    use centraid_domain::apps::entity::PhoneDifferenceRow;

    struct TestDoor;

    impl super::super::door::Door for TestDoor {
        fn act(&self, _: &Act) -> Result<Done, Refused> {
            Err(Refused("not used".to_owned()))
        }

        fn undo(&self) -> Result<Done, Refused> {
            Err(Refused("not used".to_owned()))
        }

        fn now_ms(&self) -> i64 {
            0
        }
    }

    fn difference(stated: &str) -> PhoneDifferenceRow {
        PhoneDifferenceRow {
            id: "source-1".to_owned(),
            origin_id: "origin-1".to_owned(),
            system: "contacts".to_owned(),
            external_id: "external-1".to_owned(),
            stated: stated.to_owned(),
            stated_title: serde_json::from_str::<serde_json::Value>(stated)
                .ok()
                .and_then(|value| {
                    value
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                }),
            seen_at: "2026-11-27T00:00:00Z".to_owned(),
            origin_label: "Phone".to_owned(),
        }
    }

    #[test]
    fn phone_says_only_offers_a_changed_stated_field() {
        let current = [("given", "Given name".to_owned(), serde_json::json!("Jo"))];
        let mut matching = Sel::new();
        assert!(
            phone_says(
                &mut matching,
                &TestDoor,
                "person-1",
                &difference(r#"{"given":"Jo"}"#),
                &current
            )
            .is_none()
        );

        let mut changed = Sel::new();
        assert!(
            phone_says(
                &mut changed,
                &TestDoor,
                "person-1",
                &difference(r#"{"given":"Jordan"}"#),
                &current
            )
            .is_some()
        );
        let handlers = changed.finish().unwrap();
        assert_eq!(handlers.len(), 1);
        assert!(
            matches!(handlers.get("phone-says/source-1/given"), Some(crate::room::selector::Handler::Act(act)) if act.name == "follow.take_stated" && act.input == serde_json::json!({"entity":"person-1","field":"given","origin":"origin-1"}))
        );
    }

    #[test]
    fn an_explicit_phone_clear_is_shown_but_a_missing_field_is_not() {
        let mut cleared = Sel::new();
        assert!(
            phone_says(
                &mut cleared,
                &TestDoor,
                "person-1",
                &difference(r#"{"given":null}"#),
                &[("given", "Given name".to_owned(), serde_json::json!("Jo"))],
            )
            .is_some()
        );

        let mut unchanged = Sel::new();
        assert!(
            phone_says(
                &mut unchanged,
                &TestDoor,
                "person-1",
                &difference(r#"{"given":null}"#),
                &[("given", "Given name".to_owned(), serde_json::Value::Null)],
            )
            .is_none()
        );

        let mut absent = Sel::new();
        assert!(
            phone_says(
                &mut absent,
                &TestDoor,
                "person-1",
                &difference("{}"),
                &[("given", "Given name".to_owned(), serde_json::json!("Jo"))],
            )
            .is_none()
        );
    }

    #[test]
    fn canonical_collection_changes_are_one_scoped_take_action() {
        let mut selectors = Sel::new();
        let source = difference(r#"{"points":[{"kind":"phone","value":"+1 555 010 0000"}]}"#);
        let current = [(
            "points",
            "Contact details".to_owned(),
            serde_json::json!([{"kind":"phone","value":"+1 555 010 9999"}]),
        )];
        assert!(phone_says(&mut selectors, &TestDoor, "person-1", &source, &current).is_some());
        let handlers = selectors.finish().unwrap();
        assert_eq!(handlers.len(), 1);
        assert!(
            matches!(handlers.get("phone-says/source-1/points"), Some(crate::room::selector::Handler::Act(act)) if act.input == serde_json::json!({"entity":"person-1","field":"points","origin":"origin-1"}))
        );
    }

    #[test]
    fn imported_title_uses_its_separate_stated_title() {
        let mut selectors = Sel::new();
        let mut source = difference("{}");
        source.stated_title = Some("Phone name".to_owned());
        let current = [("title", "Title".to_owned(), serde_json::json!("Vault name"))];
        assert!(phone_says(&mut selectors, &TestDoor, "event-1", &source, &current).is_some());
        let handlers = selectors.finish().unwrap();
        assert!(
            matches!(handlers.get("phone-says/source-1/title"), Some(crate::room::selector::Handler::Act(act)) if act.input == serde_json::json!({"entity":"event-1","field":"title","origin":"origin-1"}))
        );
    }
}
