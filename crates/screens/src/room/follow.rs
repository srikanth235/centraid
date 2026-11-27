//! FOLLOWING A PHONE STORE, AS A MORE SHEET SAYS IT (app-plane §16). Each owning app puts these
//! rows in its More: one to turn the store on, the state it is in, one to stop. A row asks the core
//! through the door (`FollowRequest`); the core decides what the shell reads and whether the OS
//! may be asked. The room reloads on the `follow` watch when a pass or a refusal changes the state.

use centraid_api_proto::core_v1 as wire;

use super::blocks;
use super::door::Door;
use super::screen::{Build, Event, Outcome};
use super::selector::Handler;
use crate::kit::permission::{self, Resource, State};
use crate::strings::{Locale, fill, follow as words};

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
    let with_store = |template: String| fill(&template, &[("store", &name)]);
    let tag = |verb: &str| Handler::Tag(format!("follow:{verb}:{system}"));
    let mut rows = Vec::new();
    let blocked = wire::FollowGrant::try_from(status.blocked).unwrap_or_default();
    if blocked == wire::FollowGrant::Unavailable {
        let mut row = blocks::menu_item(
            &mut b.sel,
            &format!("more/follow-{system}"),
            &with_store(words::unavailable_row(EN)),
            tag("note"),
        );
        row.secondary = String::new();
        rows.push(row);
    } else if let Some(state) = blocked_state(blocked) {
        let mut row = blocks::menu_item(
            &mut b.sel,
            &format!("more/follow-{system}"),
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
                &format!("more/follow-{system}-again"),
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
            &format!("more/follow-{system}"),
            &label,
            tag("note"),
        );
        row.secondary = partial(&status, system).unwrap_or_else(|| words::following_meta(EN));
        rows.push(row);
        if system != "files" {
            let mut stop = blocks::menu_item(
                &mut b.sel,
                &format!("more/follow-{system}-stop"),
                &with_store(words::stop_row(EN)),
                tag("stop"),
            );
            stop.destructive = true;
            rows.push(stop);
        }
    } else {
        rows.push(blocks::menu_item(
            &mut b.sel,
            &format!("more/follow-{system}"),
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
        "stopref" => {
            let (system, origin) = system.split_once(':')?;
            let request = wire::Request {
                kind: Some(wire::request::Kind::Follow(wire::FollowRequest {
                    verb: wire::FollowVerb::Stop as i32,
                    system: system.to_owned(),
                    input_json: serde_json::json!({ "ref": origin }).to_string(),
                    ..Default::default()
                })),
            };
            e.door.call(&request).map_or_else(
                |refused| Outcome::refuse(&refused.0),
                |_| {
                    Outcome::say(&fill(
                        &words::stopped_status(EN),
                        &[("store", &store(system))],
                    ))
                },
            )
        }
        "enrol" => ask(e.door, wire::FollowVerb::Enrol, system).map_or_else(
            |refused| Outcome::refuse(&refused.0),
            |()| Outcome::default(),
        ),
        "settings" => ask(e.door, wire::FollowVerb::Settings, system).map_or_else(
            |refused| Outcome::refuse(&refused.0),
            |()| Outcome::default(),
        ),
        "stop" => ask(e.door, wire::FollowVerb::Stop, system).map_or_else(
            |refused| Outcome::refuse(&refused.0),
            |()| {
                Outcome::say(&fill(
                    &words::stopped_status(EN),
                    &[("store", &store(system))],
                ))
            },
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
