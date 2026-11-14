//! `imports.made`: WHAT A MADE VAULT BRINGS IN (R-ONBOARD-8; the imports lane C3 dropped, #1135).
//!
//! Making a vault reads the OS photo grant, and an existing grant starts the camera-roll walk.
//! The importers then read in turn using existing grants: Contacts, Calendar, then Reminders
//! (iOS only). Creating a vault is not consent to a permission prompt; each app's explicit import
//! action asks at the moment of need. One line says what
//! came in ("6 people, 12 events imported"); a store the member refused, or one with nothing to
//! bring, says nothing, and no line shows when nothing came in.
//!
//! The importers are the apps' own: People's [`ContactsFollow`] and Agenda's [`CalendarFollow`]
//! (so a calendar imported here is followed from now on, exactly as one imported from Calendar's
//! home: the follow coordinator takes it from the import), and [`super::reminders`]. This screen only sequences them and says the result.
//!
//! The shell tells it when the vault is made (`Made`), reads the photo grant
//! (`LibraryPermission{ask:false}`) and the importers' reads as it always does, and stops drawing its
//! line when the view says `finished`. A grant asks the camera roll to walk, by name.

use centraid_api_proto::core_v1 as wire;
use wire::imports_made_event::Kind as M;
use wire::screen_event::Kind as E;

use super::{effect, reminders};
use crate::calendar::follow::{self as calendar, CalendarFollow};
use crate::kit::permission::{self, Resource};
use crate::people::contacts::{self, ContactsFollow};
use crate::screen::{Ctx, Screen};
use crate::shell::row_routes as rows;
use crate::strings::{Locale, fill, imports as words};

/// THIS DEVICE FOLLOWS ITS REMINDERS from now on, once the vault took a list: the habit is written
/// and the coordinator told.
fn followed(ctx: &Ctx, outcome: &reminders::Outcome) -> Vec<wire::Effect> {
    if !outcome.told {
        return Vec::new();
    }
    ctx.follows().changed(ctx, crate::follow::Store::Reminders);
    // Reminders' More sheet says "Stop reading" now: its home reads what the vault stores again.
    ctx.post(
        crate::reminders::HOME,
        wire::ScreenEvent {
            kind: Some(wire::screen_event::Kind::DataChanged(wire::DataChanged {
                tables: Vec::new(),
            })),
        },
    );
    vec![reminders::habit_set()]
}

/// The reason a shell gives when the phone has no Reminders store to read: the fact, never words.
pub use crate::effect_reason::UNAVAILABLE;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Imports(_)) = &route.args else {
        return None;
    };
    Some(Box::new(Made {
        step: Step::Idle,
        reminders: false,
        include_completed: false,
        standalone: false,
        contacts: ContactsFollow::new(),
        calendar: CalendarFollow::new(),
        came: Vec::new(),
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Idle,
    Photos,
    Contacts,
    Calendar,
    Reminders,
    Done,
}

/// What one importer brought: the app it wrote to and its outcome sentence, or nothing.
struct Came {
    app: &'static str,
    sentence: String,
}

struct Made {
    step: Step,
    reminders: bool,
    /// The member's option "Include completed reminders" for the reminders import.
    include_completed: bool,
    /// The reminders import is the member's own tap, not a made vault's step: its line says
    /// everything, even that nothing came in, and the service is not finished by it.
    standalone: bool,
    contacts: ContactsFollow,
    calendar: CalendarFollow,
    came: Vec<Came>,
}

/// WHAT A MADE VAULT'S IMPORTS SAY, AS ONE LINE: the fragments, each ending in its verb
/// ("6 people imported", "1 event imported"), with the shared last word said once. Empty when
/// nothing came in.
#[must_use]
pub fn summary(fragments: &[String]) -> String {
    let said: Vec<&str> = fragments
        .iter()
        .map(|fragment| fragment.trim().trim_end_matches('.'))
        .filter(|fragment| !fragment.is_empty())
        .collect();
    let verbs: std::collections::BTreeSet<&str> = said
        .iter()
        .map(|fragment| fragment.rsplit(' ').next().unwrap_or(""))
        .collect();
    if said.len() < 2 || verbs.len() != 1 || verbs.contains("") {
        return said.join(", ");
    }
    let (last, rest) = said.split_last().expect("two or more fragments");
    let heads: Vec<&str> = rest
        .iter()
        .map(|fragment| {
            fragment
                .rsplit_once(' ')
                .map_or(*fragment, |(head, _)| head)
        })
        .collect();
    format!("{}, {}", heads.join(", "), last)
}

/// "Open People": the line's one action, for the app that received the first import.
#[must_use]
pub fn open_label(locale: Locale, app: &str) -> String {
    let name = match app {
        "people" => words::app_people(locale),
        "calendar" => words::app_calendar(locale),
        "reminders" => words::app_reminders(locale),
        "photos" => words::app_photos(locale),
        _ => return String::new(),
    };
    fill(&words::open_app(locale), &[("name", &name)])
}

impl Made {
    /// Move to the next importer and start it.
    fn next(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut effects = match self.step {
            Step::Idle => {
                self.step = Step::Photos;
                vec![effect(wire::effect::Kind::LibraryPermission(
                    wire::LibraryPermission { ask: true },
                ))]
            }
            Step::Photos => {
                self.step = Step::Contacts;
                self.contacts.import(ctx)
            }
            Step::Contacts => {
                if let Some(outcome) = self.contacts.outcome()
                    && outcome.added > 0
                {
                    self.came.push(Came {
                        app: "people",
                        sentence: contacts::sentence(ctx.locale(), outcome),
                    });
                }
                self.step = Step::Calendar;
                self.calendar.import(ctx)
            }
            Step::Calendar => {
                if let Some(outcome) = self.calendar.outcome()
                    && outcome.added > 0
                {
                    self.came.push(Came {
                        app: "calendar",
                        sentence: calendar::sentence(ctx.locale(), outcome),
                    });
                }
                if self.reminders {
                    self.step = Step::Reminders;
                    vec![effect(wire::effect::Kind::RemindersRead(
                        wire::RemindersRead {
                            ask_permission: true,
                            include_completed: self.include_completed,
                        },
                    ))]
                } else {
                    self.step = Step::Done;
                    Vec::new()
                }
            }
            Step::Reminders | Step::Done => {
                self.step = Step::Done;
                Vec::new()
            }
        };
        // The same importers also serve explicit Import taps, which may ask. This automatic
        // sequence only uses access the phone already granted, on both native shells.
        for effect in &mut effects {
            match effect.kind.as_mut() {
                Some(wire::effect::Kind::LibraryPermission(read)) => read.ask = false,
                Some(wire::effect::Kind::ContactsRead(read)) => read.ask_permission = false,
                Some(wire::effect::Kind::CalendarRead(read)) => read.ask_permission = false,
                Some(wire::effect::Kind::RemindersRead(read)) => read.ask_permission = false,
                _ => {}
            }
        }
        effects
    }

    /// The member's Import reminders tap: ask the OS and import, with their option.
    fn reminders_requested(
        &mut self,
        made: &wire::ImportsMadeEvent,
        _ctx: &Ctx,
    ) -> Vec<wire::Effect> {
        let Some(M::RemindersRequested(requested)) = &made.kind else {
            return Vec::new();
        };
        self.include_completed = requested.include_completed;
        self.standalone = true;
        self.came.clear();
        self.step = Step::Reminders;
        vec![effect(wire::effect::Kind::RemindersRead(
            wire::RemindersRead {
                ask_permission: true,
                include_completed: requested.include_completed,
            },
        ))]
    }

    /// An importer's read ended, however it ended.
    fn importer_ended(&mut self, ctx: &Ctx, mut effects: Vec<wire::Effect>) -> Vec<wire::Effect> {
        effects.extend(self.next(ctx));
        effects
    }
}

/// Ask the camera roll to walk, now that the member let it read.
fn walk(ctx: &Ctx) {
    use wire::imports_camera_roll_event::{Kind, Requested, requested::Action};
    ctx.post(
        super::CAMERA_ROLL,
        wire::ScreenEvent {
            kind: Some(E::ImportsCameraRoll(wire::ImportsCameraRollEvent {
                vault_id: String::new(),
                kind: Some(Kind::Requested(Requested {
                    action: Action::ImportNow as i32,
                })),
            })),
        },
    );
}

fn read_ended(result: &wire::EffectResult) -> bool {
    use wire::effect_result::Outcome as O;
    matches!(
        result.outcome,
        Some(O::Calendar(_) | O::Contacts(_) | O::Failed(_))
    )
}

impl Screen for Made {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome as O;
        let Some(kind) = event.kind else {
            return Vec::new();
        };
        match (&kind, self.step) {
            (E::ImportsMade(made), Step::Idle) => {
                if let Some(M::Made(made)) = &made.kind {
                    self.reminders = made.reminders;
                    self.include_completed = made.include_completed;
                    return self.next(ctx);
                }
                self.reminders_requested(made, ctx)
            }
            // The member's own Import reminders tap, once nothing else is running.
            (E::ImportsMade(made), Step::Done) => self.reminders_requested(made, ctx),
            // The OS photo grant was read (or the shell could not read it): a grant starts
            // the camera roll's walk, by name, and the importers go.
            (E::EffectResult(result), Step::Photos) => match &result.outcome {
                Some(O::LibraryPermissionRead(read)) => {
                    let granted = wire::PhotosMediaPermission::try_from(read.permission)
                        .is_ok_and(super::camera_roll::can_enumerate);
                    if granted {
                        walk(ctx);
                    }
                    self.next(ctx)
                }
                Some(O::Failed(_)) => self.next(ctx),
                _ => Vec::new(),
            },
            (E::EffectResult(result), Step::Contacts) => {
                let ended = read_ended(result);
                match self.contacts.on_event(&kind, ctx) {
                    Some(effects) if ended => self.importer_ended(ctx, effects),
                    Some(effects) => effects,
                    None => Vec::new(),
                }
            }
            (E::EffectResult(result), Step::Calendar) => {
                let ended = read_ended(result);
                match self.calendar.on_event(&kind, ctx) {
                    Some(effects) if ended => self.importer_ended(ctx, effects),
                    Some(effects) => effects,
                    None => Vec::new(),
                }
            }
            (E::EffectResult(result), Step::Reminders) if self.standalone => {
                let mut effects = Vec::new();
                let sentence = match &result.outcome {
                    Some(O::RemindersSnapshot(snapshot)) => {
                        let outcome =
                            reminders::run(ctx, &snapshot.reminders, self.include_completed);
                        effects = followed(ctx, &outcome);
                        reminders::status_line(ctx.locale(), outcome)
                    }
                    Some(O::Failed(failed)) if permission::State::of(failed).is_some() => {
                        permission::says(
                            ctx.locale(),
                            Resource::Reminders,
                            permission::State::of(failed).unwrap_or(permission::State::Refused),
                        )
                    }
                    Some(O::Failed(failed)) if failed.reason == UNAVAILABLE => {
                        words::reminders_unavailable(ctx.locale())
                    }
                    Some(O::Failed(_)) => {
                        crate::strings::task::import_reminders_failed(ctx.locale())
                    }
                    _ => return Vec::new(),
                };
                self.came = vec![Came {
                    app: "reminders",
                    sentence,
                }];
                self.step = Step::Done;
                effects
            }
            (E::EffectResult(result), Step::Reminders) => match &result.outcome {
                Some(O::RemindersSnapshot(snapshot)) => {
                    let outcome = reminders::run(ctx, &snapshot.reminders, self.include_completed);
                    let mut effects = followed(ctx, &outcome);
                    if outcome.added > 0 {
                        self.came.push(Came {
                            app: "reminders",
                            sentence: reminders::sentence(ctx.locale(), outcome),
                        });
                    }
                    effects.extend(self.next(ctx));
                    effects
                }
                // Refused or unavailable: it says nothing.
                Some(O::Failed(_)) => self.next(ctx),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let fragments: Vec<String> = self.came.iter().map(|came| came.sentence.clone()).collect();
        let open = self.came.first().map(|came| came.app).unwrap_or("");
        let finished = self.step == Step::Done && !self.standalone;
        wire::ViewState {
            kind: Some(wire::view_state::Kind::ImportsMade(
                wire::ImportsMadeState {
                    summary: summary(&fragments),
                    open_label: open_label(locale, open),
                    open_route: rows::app_home(open),
                    running: !matches!(self.step, Step::Idle | Step::Done),
                    finished,
                    completed_label: words::completed_toggle(locale),
                    reminders_label: words::reminders_import(locale),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_owned()).collect()
    }

    #[test]
    fn the_shared_verb_closes_the_list_once() {
        assert_eq!(
            summary(&said(&["6 people imported", "1 event imported"])),
            "6 people, 1 event imported"
        );
        assert_eq!(
            summary(&said(&[
                "6 people imported",
                "12 events imported",
                "2 tasks imported"
            ])),
            "6 people, 12 events, 2 tasks imported"
        );
    }

    #[test]
    fn one_outcome_is_said_as_it_is_and_nothing_says_nothing() {
        assert_eq!(summary(&said(&["6 people imported"])), "6 people imported");
        assert_eq!(summary(&[]), "");
        // a list whose verbs differ is joined as it is
        assert_eq!(
            summary(&said(&["6 people imported", "3 events added"])),
            "6 people imported, 3 events added"
        );
    }

    #[test]
    fn the_line_opens_the_first_app_that_received_anything() {
        assert_eq!(open_label(Locale::En, "people"), "Open People");
        assert_eq!(open_label(Locale::En, "calendar"), "Open Calendar");
        assert_eq!(open_label(Locale::En, "reminders"), "Open Reminders");
        assert_eq!(open_label(Locale::En, ""), "");
    }
}
