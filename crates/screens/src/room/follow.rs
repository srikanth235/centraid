//! FOLLOWING A PHONE STORE, AS A MORE SHEET SAYS IT (app-plane §16). Each owning app puts these
//! rows in its More: one to turn the store on, the state it is in, one to stop. A row asks the core
//! through the door (`FollowRequest`); the core decides what the shell reads and whether the OS
//! may be asked. The room reloads on the `follow` watch when a pass or a refusal changes the state.

use centraid_api_proto::core_v1 as wire;

use super::door::Door;
use super::blocks::{self, Confirm};
use super::frame::room;
use super::screen::{Build, Event, Input, Nav, Outcome, Registry, RoomScreen, Status};
use super::selector::Handler;
use crate::kit::permission::{self, Resource, State};
use crate::strings::{Locale, fill, follow as words, shared};

const EN: Locale = Locale::En;

/// The table name a room watches for a change in what a pass left.
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

/// Where a store stands on this device, as the core says it; `None` when the core would not say.
#[must_use]
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
        "settings" => ask(e.door, wire::FollowVerb::Settings, system).map_or_else(
            |refused| Outcome::refuse(&refused.0),
            |()| Outcome::default(),
        ),
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
        let holes = [("store", store(&self.system)), ("source", source(&self.system))];
        let holes = [(holes[0].0, holes[0].1.as_str()), (holes[1].0, holes[1].1.as_str())];
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
                    sentence: fill(&words::stopped_status(EN), &[("store", &store(&self.system))]),
                    undo: false,
                    refused: false,
                }),
            },
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}
