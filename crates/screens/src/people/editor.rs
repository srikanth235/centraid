//! THE PROFILE EDITOR (`people.editor`), autosaving (#1015 D3: close = done).
//!
//! Name, role, nickname and how you met save through the kit's [`Autosave`]
//! (900 ms, one key per edit, only the changed fields). The cadence is its OWN
//! action (`set-cadence`) and saves on the tap.
//!
//! A NEW PERSON is not read: nothing is in the vault under its id yet. It opens
//! on an empty draft; its first save — the first one with a name — is
//! `add-person` (the cadence rides it), whose output names the person, and every
//! save after it is `edit-person`. "Cancel" exists only before the first
//! keystroke; after it the close control is "Done" and closing saves what is
//! there.
//!
//! The editor is the screen where the read law and the WRITE law differ: a failed
//! READ replaces the editor, a failed SAVE does not. A member whose save was
//! refused still has their words on the screen.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::people_editor_event::Kind as N;
use wire::screen_event::Kind as E;

use super::{Phase, denied, fold};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::autosave::{Autosave, Draft};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, people as words};

/// The words a member types: a person not yet added has no id.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Profile {
    /// `None` until the first save adds the person.
    id: Option<String>,
    name: String,
    role: String,
    nickname: String,
    met: String,
    /// Rides `add-person` only: a person that exists has its cadence set on the tap.
    cadence_days: i64,
}

impl Draft for Profile {
    const ACTION: &'static str = "person.save";

    fn subject(&self) -> &str {
        self.id.as_deref().unwrap_or("new")
    }

    /// A person needs a name: the command refuses an empty one.
    fn refusal(&self, locale: Locale) -> Option<String> {
        self.name
            .trim()
            .is_empty()
            .then(|| words::name_needed(locale))
    }

    /// `add-person` with the whole draft, or `edit-person` with ONLY THE FIELDS THAT
    /// CHANGED against `baseline`. The cadence is not one of them.
    fn request(&self, baseline: &Self) -> Option<wire::ActRequest> {
        let Some(id) = &self.id else {
            return Some(
                act::people::AddPerson {
                    title: self.name.trim().to_owned(),
                    cadence_days: Some(self.cadence_days),
                    role: Some(self.role.clone()).filter(|role| !role.is_empty()),
                    nickname: Some(self.nickname.clone()).filter(|nick| !nick.is_empty()),
                    met: Some(self.met.clone()).filter(|met| !met.is_empty()),
                    ..Default::default()
                }
                .into(),
            );
        };
        let name = self.name.trim();
        let changed = |now: &str, then: &str| (now != then).then(|| now.to_owned());
        let edit = act::people::EditPerson {
            person_id: id.clone(),
            title: changed(name, baseline.name.trim()),
            role: changed(&self.role, &baseline.role),
            nickname: changed(&self.nickname, &baseline.nickname),
            met: changed(&self.met, &baseline.met),
            ..Default::default()
        };
        let moved = edit.title.is_some()
            || edit.role.is_some()
            || edit.nickname.is_some()
            || edit.met.is_some();
        moved.then(|| edit.into())
    }

    fn committed(&mut self, output: &[u8]) {
        if self.id.is_some() {
            return;
        }
        self.id = serde_json::from_slice::<serde_json::Value>(output)
            .ok()
            .and_then(|value| value.get("id")?.as_str().map(str::to_owned));
    }
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PeopleEditor(args)) = &route.args else {
        return None;
    };
    if args.party_id.is_empty() && !args.is_new {
        return None;
    }
    let mut autosave = Autosave::new();
    let phase = if args.is_new && args.party_id.is_empty() {
        // A NEW PERSON has nothing to read: an empty draft, and no baseline — the first save
        // sends everything it has.
        autosave.loaded(Profile {
            id: None,
            name: String::new(),
            role: String::new(),
            nickname: String::new(),
            met: String::new(),
            cadence_days: 0,
        });
        Phase::Ready(true)
    } else {
        Phase::Loading
    };
    Some(Box::new(Editor {
        is_new: args.is_new,
        party_id: args.party_id.clone(),
        phase,
        autosave,
        cadence: 0,
        touched: false,
        status: None,
    }))
}

struct Editor {
    is_new: bool,
    /// The person, once there is one to read.
    party_id: String,
    /// `Ready(false)`: the person is not there to edit.
    phase: Phase<bool>,
    autosave: Autosave<Profile>,
    /// A person that exists: the vault's cadence, set on the tap.
    cadence: i64,
    /// False before the first keystroke of a new person: close then discards.
    touched: bool,
    /// A refused cadence.
    status: Option<wire::StatusLine>,
}

impl Editor {
    /// The person exists in the vault: read it. A new person that is not yet added
    /// reads nothing.
    fn reload(&mut self, ctx: &Ctx) {
        let id = self
            .autosave
            .draft()
            .and_then(|draft| draft.id.clone())
            .unwrap_or_else(|| self.party_id.clone());
        if id.is_empty() {
            return;
        }
        let reading = read::read(
            ctx,
            load::people::Person {
                party_id: id.clone(),
            },
            |answer| match answer {
                Answer::PeoplePerson(person) => Some(person),
                _ => None,
            },
        );
        match reading {
            Reading::Data(person) => match person.sheet {
                None => self.phase = Phase::Ready(false),
                Some(sheet) => {
                    let row = sheet.person.unwrap_or_default();
                    self.party_id = id.clone();
                    self.cadence = row.cadence_days;
                    let fresh = Profile {
                        id: Some(id),
                        name: row.name,
                        role: row.role,
                        nickname: sheet.nickname,
                        met: sheet.met,
                        cadence_days: row.cadence_days,
                    };
                    // Over words being typed a change from the vault replaces NOTHING.
                    self.autosave.loaded(fresh);
                    self.phase = Phase::Ready(true);
                }
            },
            // A refused read over words being typed keeps the words.
            Reading::Denied(_) | Reading::Failed if self.autosave.draft().is_some() => {}
            Reading::Denied(denial) => self.phase = Phase::Denied(denial),
            Reading::Failed => self.phase = Phase::Failed,
        }
    }

    fn edited(&mut self, ctx: &Ctx, change: impl FnOnce(&mut Profile)) {
        let before = self.autosave.draft().cloned();
        self.autosave.edit(ctx, change);
        if self.autosave.draft().cloned() != before {
            self.touched = true;
        }
    }

    fn cadence_picked(&mut self, ctx: &Ctx, days: i64) {
        let Some(draft) = self.autosave.draft() else {
            return;
        };
        if days < 0 {
            return;
        }
        let exists = draft.id.is_some();
        if !exists {
            // Not a person yet: the cadence rides `add-person`.
            self.edited(ctx, |draft| draft.cadence_days = days);
            return;
        }
        if days == self.cadence {
            return;
        }
        let request: wire::ActRequest = act::people::SetCadence {
            person_id: draft.id.clone().unwrap_or_default(),
            cadence_days: days,
        }
        .into();
        let key = kit_act::key(&["set-cadence", &self.party_id], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.touched = true;
        if settled.committed {
            self.cadence = days;
            self.status = None;
        } else {
            self.status = Some(wire::StatusLine {
                sentence: settled.refusal,
                action_label: String::new(),
                refused: true,
            });
        }
        self.reload(ctx);
    }

    /// A save may have added the person: from then on there is a row to read, and the screen
    /// follows it. `again`: the vault moved while words were unsaved, and they are saved now.
    fn saved(&mut self, ctx: &Ctx, again: bool) {
        let added = self.party_id.is_empty()
            && self
                .autosave
                .draft()
                .is_some_and(|draft| draft.id.is_some());
        if added || again {
            self.reload(ctx);
        }
    }

    fn event(&mut self, event: wire::PeopleEditorEvent, ctx: &Ctx) {
        let Some(kind) = event.kind else {
            return;
        };
        match kind {
            N::Refreshed(_) => self.reload(ctx),
            N::Name(typed) => self.edited(ctx, |draft| draft.name = typed.text),
            N::Role(typed) => self.edited(ctx, |draft| draft.role = typed.text),
            N::Nickname(typed) => self.edited(ctx, |draft| draft.nickname = typed.text),
            N::Met(typed) => self.edited(ctx, |draft| draft.met = typed.text),
            N::Cadence(picked) => self.cadence_picked(ctx, picked.days),
        }
    }

    /// The cadence on screen: the draft's for a person to be added, else the vault's.
    fn cadence_shown(&self) -> i64 {
        match self.autosave.draft() {
            Some(draft) if draft.id.is_none() => draft.cadence_days,
            _ => self.cadence,
        }
    }

    fn chrome(&self, locale: Locale) -> wire::PeopleEditorChrome {
        wire::PeopleEditorChrome {
            title: if self.is_new {
                words::editor_new(locale)
            } else {
                words::editor_edit(locale)
            },
            name_field: words::field_name(locale),
            role_field: words::field_role(locale),
            role_placeholder: words::field_role_placeholder(locale),
            nickname_field: words::field_nickname(locale),
            met_field: words::field_met(locale),
            cadence_field: words::field_cadence(locale),
            close_label: if self.is_new && !self.touched {
                words::cancel(locale)
            } else {
                words::done(locale)
            },
            retry: words::retry(locale),
            loading: words::loading(locale),
        }
    }

    fn cadences(&self, locale: Locale) -> Vec<wire::PeopleCadenceChoice> {
        let shown = self.cadence_shown();
        fold::CADENCES
            .iter()
            .map(|days| wire::PeopleCadenceChoice {
                days: *days,
                label: if *days == 0 {
                    words::cadence_never(locale)
                } else {
                    words::cadence_days(locale, days.unsigned_abs())
                },
                selected: *days == shown,
            })
            .collect()
    }
}

impl Screen for Editor {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::EnvironmentChanged(_)) => {
                if !self.party_id.is_empty() {
                    self.reload(ctx);
                }
            }
            // A change from the vault never overwrites words being typed; a new person
            // that is not yet added has nothing to read.
            Some(E::DataChanged(_)) => self.reload(ctx),
            Some(E::TimerFired(fired)) => {
                let again = self.autosave.fired(ctx, &fired.timer);
                self.saved(ctx, again);
            }
            // CLOSE = DONE: the words typed are saved on the way out.
            Some(E::Left(_)) => {
                let again = self.autosave.flush(ctx);
                self.saved(ctx, again);
            }
            Some(E::PeopleEditor(editor)) => self.event(editor, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::people_editor_state::Content as C;
        let locale = ctx.locale();
        let content = match (&self.phase, self.autosave.draft()) {
            (Phase::Failed, None) => C::Failure(read::failure(locale)),
            (Phase::Denied(denial), None) => C::Denied(denied(locale, denial)),
            (Phase::Ready(false), _) => C::Gone(super::person::gone(locale)),
            (_, Some(draft)) => C::Draft(wire::PeopleProfileDraft {
                display_name: draft.name.clone(),
                role: draft.role.clone(),
                nickname: draft.nickname.clone(),
                met: draft.met.clone(),
            }),
            _ => C::Loading(wire::Loading { first_load: true }),
        };
        let draft_shown = self.autosave.draft().is_some();
        let state = wire::PeopleEditorState {
            chrome: Some(self.chrome(locale)),
            content: Some(content),
            autosave: Some(self.autosave.view(locale)),
            cadences: if draft_shown {
                self.cadences(locale)
            } else {
                Vec::new()
            },
            status: self.status.clone(),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PeopleEditor(Box::new(state))),
            ..wire::ViewState::default()
        }
    }
}
