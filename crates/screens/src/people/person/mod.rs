//! ONE PERSON (`people.person`): the header, nickname and how you met, channels,
//! dates, notes and the touch log, and every write the page makes.
//!
//! - **Content pushes, choices sheet** (#1015 D4): Edit is the route in the view
//!   (`people.editor`); Log a touch, Add note, Add date and Add channel are write
//!   sheets over this screen; Merge is a choices sheet that picks, from the
//!   roster, who folds INTO this person.
//! - **Destroying is asked first**, in full sentences: move to trash, remove a
//!   channel (no undo), merge (cannot be undone).
//! - **Writes are synchronous.** A refused write keeps the sheet and its fields
//!   with the sentence over them; with no sheet, the sentence goes on the status
//!   line. Nothing on screen changes on a guess: what committed is in the next
//!   load.
//! - A person moved to the trash here sets `done`: the shell pops. One gone by any
//!   other road (merged away, trashed elsewhere) draws the `gone` state with a way
//!   back.
//!
//! Calling, mailing and opening a map are Rust's to ask for as effects
//! (`ChannelTapped`): `OpenUrl` for `tel:` and `mailto:`, `OpenMap`, or the
//! clipboard for a handle.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::people_person_event::Kind as P;
use wire::screen_event::Kind as E;

use super::{Phase, denied, fold, routes};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, people as words};

mod data;
mod sheets;

pub(crate) use data::gone;

use data::BIRTHDAY_PREFIX;
use sheets::{Form, Merge, Sheet};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PeoplePerson(args)) = &route.args else {
        return None;
    };
    // A person with no id names nothing.
    if args.party_id.is_empty() {
        return None;
    }
    Some(Box::new(Person {
        party_id: args.party_id.clone(),
        name_hint: args.name.clone(),
        phase: Phase::Loading,
        opening_log: args.log_touch,
        sheet: None,
        asking: Asking::Nothing,
        status: None,
        done: false,
    }))
}

/// What a confirm on screen will do once the member says so.
enum Asking {
    Nothing,
    Trash,
    RemoveChannel(String),
    Merge { party_id: String, name: String },
}

struct Person {
    party_id: String,
    name_hint: String,
    /// `None` inside `Ready`: no live person has this id.
    phase: Phase<Option<(wire::PeopleSheet, String)>>,
    /// The route asked for the Log a touch sheet at once; it opens with the data.
    opening_log: bool,
    sheet: Option<Sheet>,
    asking: Asking,
    status: Option<wire::StatusLine>,
    done: bool,
}

impl Person {
    fn reload(&mut self, ctx: &Ctx) {
        let reading = read::read(
            ctx,
            load::people::Person {
                party_id: self.party_id.clone(),
            },
            |answer| match answer {
                Answer::PeoplePerson(person) => Some(person),
                _ => None,
            },
        );
        self.phase = Phase::of(match reading {
            read::Reading::Data(person) => {
                read::Reading::Data(person.sheet.map(|sheet| (sheet, person.today)))
            }
            read::Reading::Denied(denial) => read::Reading::Denied(denial),
            read::Reading::Failed => read::Reading::Failed,
        });
        match &self.phase {
            // GONE: nothing to write to, and no sheet over nothing.
            Phase::Ready(None) => {
                self.sheet = None;
                self.asking = Asking::Nothing;
            }
            Phase::Denied(_) => self.sheet = None,
            Phase::Ready(Some(_)) if self.opening_log => {
                self.opening_log = false;
                self.sheet = Some(Sheet::log_touch(ctx.locale()));
            }
            _ => {}
        }
    }

    /// The sheet's data, once it has arrived.
    fn loaded(&self) -> Option<&(wire::PeopleSheet, String)> {
        self.phase.data().and_then(Option::as_ref)
    }

    fn name(&self) -> String {
        self.loaded()
            .and_then(|(sheet, _)| sheet.person.as_ref())
            .map(|person| person.name.clone())
            .unwrap_or_default()
    }

    fn starred(&self) -> bool {
        self.loaded()
            .and_then(|(sheet, _)| sheet.person.as_ref())
            .is_some_and(|person| person.starred)
    }

    // --- Sheets ------------------------------------------------------------

    fn sheet_opened(&mut self, ctx: &Ctx, which: wire::people_person_event::sheet_opened::Which) {
        use wire::people_person_event::sheet_opened::Which as W;
        if self.loaded().is_none() {
            return;
        }
        let locale = ctx.locale();
        self.status = None;
        self.sheet = Some(match which {
            W::LogTouch => Sheet::log_touch(locale),
            W::Note => Sheet::note(),
            W::Date => Sheet::date(),
            W::Channel => Sheet::channel(locale),
            W::Merge => Sheet::merge(self.merge_choices(ctx)),
            W::Unspecified => return,
        });
    }

    /// Everyone who could be folded in, by name, the person themselves dropped.
    fn merge_choices(&self, ctx: &Ctx) -> Merge {
        let request = load::people::People {
            filter: Some("all".to_owned()),
            limit: 0,
            sort: Some("name".to_owned()),
        };
        match read::read(ctx, request, |answer| match answer {
            Answer::PeopleRoster(roster) => Some(roster),
            _ => None,
        }) {
            read::Reading::Data(roster) => Merge::Choices(
                roster
                    .people
                    .into_iter()
                    .filter(|person| person.party_id != self.party_id)
                    .collect(),
            ),
            _ => Merge::Failed,
        }
    }

    fn submitted(&mut self, ctx: &Ctx) {
        let Some(sheet) = &self.sheet else {
            return;
        };
        if !sheet.can_submit() || self.loaded().is_none() {
            return;
        }
        let locale = ctx.locale();
        let name = self.name();
        let id = self.party_id.clone();
        let (request, outcome): (wire::ActRequest, String) = match &sheet.form {
            Form::LogTouch(form) => {
                let kind = form.kinds.key();
                let note = form.note.trim();
                (
                    act::people::LogInteraction {
                        person_id: id,
                        kind: kind.to_owned(),
                        text: Some(note.to_owned()).filter(|note| !note.is_empty()),
                    }
                    .into(),
                    fill(
                        &words::outcome_logged(locale),
                        &[("kind", &fold::touch_kind(locale, kind)), ("name", &name)],
                    ),
                )
            }
            Form::Note(form) => (
                act::people::AddNote {
                    id,
                    text: form.text.trim().to_owned(),
                }
                .into(),
                fill(&words::outcome_noted(locale), &[("name", &name)]),
            ),
            Form::Date(form) => (
                act::people::AddImportantDate {
                    id,
                    label: form.label.trim().to_owned(),
                    month_day: form.month_day.clone(),
                    reminder_on: Some(form.reminder_on),
                }
                .into(),
                fill(&words::outcome_dated(locale), &[("name", &name)]),
            ),
            Form::Channel(form) => {
                let kind = form.kinds.key();
                let label = form.label.trim();
                (
                    act::people::SaveContactChannel {
                        contact_point_id: id,
                        kind: match kind {
                            "email" => act::people::SaveContactChannelKind::Email,
                            "address" => act::people::SaveContactChannelKind::Address,
                            "handle" => act::people::SaveContactChannelKind::Handle,
                            _ => act::people::SaveContactChannelKind::Phone,
                        },
                        value: form.value.trim().to_owned(),
                        label: if label.is_empty() {
                            crate::field::Field::Keep
                        } else {
                            crate::field::Field::Is(label.to_owned())
                        },
                        point_id: None,
                        preferred: Some(form.preferred),
                    }
                    .into(),
                    fill(
                        &words::outcome_channel_saved(locale),
                        &[("kind", &fold::channel_kind(locale, kind))],
                    ),
                )
            }
            Form::Merge(_) => return,
        };
        let key = kit_act::key(&[&request.action.clone(), &self.party_id], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if settled.committed {
            // A WRITE SHEET CLOSES ON ITS COMMIT; the load shows what was written.
            self.sheet = None;
            self.status = Some(plain(outcome));
        } else if let Some(sheet) = &mut self.sheet {
            sheet.failure = Some(settled.refusal);
        }
        self.reload(ctx);
    }

    // --- Writes ------------------------------------------------------------

    /// One write with no sheet over it: the outcome or the refusal is the status
    /// line. Returns whether it committed.
    fn write(
        &mut self,
        ctx: &Ctx,
        request: wire::ActRequest,
        subject: &str,
        outcome: String,
    ) -> bool {
        let key = kit_act::key(&[&request.action.clone(), subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.status = Some(if settled.committed {
            plain(outcome)
        } else {
            refused(settled.refusal)
        });
        if settled.committed {
            self.reload(ctx);
        }
        settled.committed
    }

    fn star(&mut self, ctx: &Ctx) {
        if self.loaded().is_none() {
            return;
        }
        let locale = ctx.locale();
        let name = self.name();
        let id = self.party_id.clone();
        let starred = self.starred();
        let (request, outcome): (wire::ActRequest, String) = if starred {
            (
                act::people::UnstarPerson { person_id: id }.into(),
                fill(&words::outcome_unstarred(locale), &[("name", &name)]),
            )
        } else {
            (
                act::people::StarPerson { person_id: id }.into(),
                fill(&words::outcome_starred(locale), &[("name", &name)]),
            )
        };
        let party = self.party_id.clone();
        self.write(ctx, request, &party, outcome);
    }

    fn reminder(&mut self, ctx: &Ctx, date_id: &str) {
        let Some((sheet, _)) = self.loaded() else {
            return;
        };
        // A birthday is the person's own column and always has its reminder; any other date's is its event's.
        if date_id.starts_with(BIRTHDAY_PREFIX) {
            return;
        }
        let Some(date) = sheet.dates.iter().find(|date| date.date_id == date_id) else {
            return;
        };
        let locale = ctx.locale();
        let turns_on = !date.reminder_on;
        let label = date.label.clone();
        let request = act::people::SetReminder {
            important_date_id: date_id.to_owned(),
            reminders: turns_on.then(|| "[0]".to_owned()),
        };
        let outcome = fill(
            &if turns_on {
                words::outcome_reminder_on(locale)
            } else {
                words::outcome_reminder_off(locale)
            },
            &[("label", &label)],
        );
        self.write(ctx, request.into(), date_id, outcome);
    }

    fn ask_remove_channel(&mut self, channel_id: &str) {
        if self
            .loaded()
            .is_some_and(|(sheet, _)| sheet.channels.iter().any(|c| c.channel_id == channel_id))
        {
            self.asking = Asking::RemoveChannel(channel_id.to_owned());
        }
    }

    fn ask_merge(&mut self, party_id: &str) {
        if party_id == self.party_id {
            return;
        }
        let Some(Sheet {
            form: Form::Merge(Merge::Choices(choices)),
            ..
        }) = &self.sheet
        else {
            return;
        };
        let Some(picked) = choices.iter().find(|row| row.party_id == party_id) else {
            return;
        };
        self.asking = Asking::Merge {
            party_id: party_id.to_owned(),
            name: picked.name.clone(),
        };
        self.sheet = None;
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        let locale = ctx.locale();
        let name = self.name();
        match std::mem::replace(&mut self.asking, Asking::Nothing) {
            Asking::Trash => {
                let request = act::people::TrashPerson {
                    person_id: self.party_id.clone(),
                };
                let outcome = fill(&words::outcome_trashed(locale), &[("name", &name)]);
                let party = self.party_id.clone();
                if self.write(ctx, request.into(), &party, outcome) {
                    self.done = true;
                }
            }
            Asking::RemoveChannel(channel_id) => {
                let kind = self
                    .loaded()
                    .and_then(|(sheet, _)| {
                        sheet
                            .channels
                            .iter()
                            .find(|channel| channel.channel_id == channel_id)
                    })
                    .map(|channel| fold::channel_kind(locale, &channel.kind))
                    .unwrap_or_default();
                let request = act::people::DeleteContactChannel {
                    point_id: channel_id.clone(),
                };
                let outcome = fill(&words::outcome_channel_removed(locale), &[("kind", &kind)]);
                self.write(ctx, request.into(), &channel_id, outcome);
            }
            Asking::Merge {
                party_id,
                name: dupe,
            } => {
                // THIS PERSON IS KEPT; the one picked folds into them.
                let request = act::people::MergePeople {
                    from: party_id.clone(),
                    into: self.party_id.clone(),
                };
                let outcome = fill(
                    &words::outcome_merged(locale),
                    &[("dupe", &dupe), ("keep", &name)],
                );
                self.write(ctx, request.into(), &party_id, outcome);
            }
            Asking::Nothing => {}
        }
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        match &self.asking {
            Asking::Nothing => None,
            Asking::Trash => Some(wire::Confirm {
                title: fill(
                    &words::confirm_trash_title(locale),
                    &[("name", &self.name())],
                ),
                body: words::confirm_trash_body(locale),
                confirm_label: words::move_to_trash(locale),
                destructive: true,
            }),
            Asking::RemoveChannel(id) => {
                let kind = self
                    .loaded()
                    .and_then(|(sheet, _)| sheet.channels.iter().find(|c| &c.channel_id == id))
                    .map(|channel| fold::channel_kind(locale, &channel.kind).to_lowercase())
                    .unwrap_or_default();
                Some(wire::Confirm {
                    title: fill(
                        &words::confirm_remove_channel_title(locale),
                        &[("kind", &kind)],
                    ),
                    body: words::confirm_remove_channel_body(locale),
                    confirm_label: words::remove(locale),
                    destructive: true,
                })
            }
            Asking::Merge { name, .. } => Some(wire::Confirm {
                title: fill(
                    &words::confirm_merge_title(locale),
                    &[("dupe", name), ("keep", &self.name())],
                ),
                body: words::confirm_merge_body(locale),
                confirm_label: words::merge(locale),
                destructive: true,
            }),
        }
    }

    /// A channel tapped: the OS is asked to call, mail, map or copy the value. The
    /// value is the member's own words; the URL is only its envelope.
    fn channel_tapped(&self, channel_id: &str) -> Vec<wire::Effect> {
        use wire::effect::Kind as K;
        let Some(channel) = self.loaded().and_then(|(sheet, _)| {
            sheet
                .channels
                .iter()
                .find(|channel| channel.channel_id == channel_id)
        }) else {
            return Vec::new();
        };
        let value = channel.value.trim();
        if value.is_empty() {
            return Vec::new();
        }
        let kind = match fold::channel_intent(&channel.kind) {
            wire::PeopleChannelIntent::Call => {
                let dialable: String = value
                    .chars()
                    .filter(|c| c.is_ascii_digit() || matches!(c, '+' | '*' | '#'))
                    .collect();
                K::OpenUrl(wire::OpenUrl {
                    url: format!("tel:{}", percent_encode(&dialable)),
                })
            }
            wire::PeopleChannelIntent::Mail => K::OpenUrl(wire::OpenUrl {
                url: format!("mailto:{}", percent_encode(value)),
            }),
            wire::PeopleChannelIntent::Map => K::OpenMap(wire::OpenMap {
                query: value.to_owned(),
            }),
            _ => K::ClipboardSet(wire::ClipboardSet {
                text: value.to_owned(),
                sensitive: false,
                clear_after_ms: 0,
            }),
        };
        vec![wire::Effect { kind: Some(kind) }]
    }

    fn event(&mut self, event: wire::PeoplePersonEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(kind) = event.kind else {
            return Vec::new();
        };
        match kind {
            P::Refreshed(_) => self.reload(ctx),
            P::Star(_) => self.star(ctx),
            P::SheetOpened(opened) => self.sheet_opened(
                ctx,
                wire::people_person_event::sheet_opened::Which::try_from(opened.which)
                    .unwrap_or_default(),
            ),
            P::SheetClosed(_) => self.sheet = None,
            P::KindPicked(picked) => {
                if let Some(sheet) = &mut self.sheet {
                    sheet.kind_picked(&picked.key);
                }
            }
            P::Text(typed) => {
                if let Some(sheet) = &mut self.sheet {
                    sheet.text(typed.text);
                }
            }
            P::SecondText(typed) => {
                if let Some(sheet) = &mut self.sheet {
                    sheet.second_text(typed.text);
                }
            }
            P::Flag(_) => {
                if let Some(sheet) = &mut self.sheet {
                    sheet.flag();
                }
            }
            P::Submitted(_) => self.submitted(ctx),
            P::Reminder(toggled) => self.reminder(ctx, &toggled.date_id),
            P::RemoveChannel(tapped) => self.ask_remove_channel(&tapped.channel_id),
            P::MergePicked(picked) => self.ask_merge(&picked.party_id),
            P::TrashTapped(_) => {
                if self.loaded().is_some() {
                    self.asking = Asking::Trash;
                }
            }
            P::Confirmed(_) => self.confirmed(ctx),
            P::Dismissed(_) => self.asking = Asking::Nothing,
            P::Channel(tapped) => return self.channel_tapped(&tapped.channel_id),
        }
        Vec::new()
    }

    fn chrome(locale: Locale) -> wire::PeoplePersonChrome {
        wire::PeoplePersonChrome {
            edit: words::edit(locale),
            log_touch: words::log_touch(locale),
            add_note: words::add_note(locale),
            add_date: words::add_date(locale),
            add_channel: words::add_channel(locale),
            merge: words::merge(locale),
            move_to_trash: words::move_to_trash(locale),
            retry: words::retry(locale),
            loading: words::loading(locale),
            back: words::app_title(locale),
        }
    }
}

/// The URL-safe spelling of a value: anything but letters, digits and a few marks
/// is `%XX`.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'@' | b'.' | b'+' | b'-' | b'_' | b'~' | b'*')
        {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn plain(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: false,
    }
}

fn refused(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: true,
    }
}

impl Screen for Person {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::DataChanged(_)) => {
                if !self.done {
                    self.reload(ctx);
                }
            }
            Some(E::PeoplePerson(person)) => return self.event(person, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::people_person_state::Content as C;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => C::Loading(wire::Loading { first_load: true }),
            Phase::Failed => C::Failure(read::failure(locale)),
            Phase::Denied(denial) => C::Denied(denied(locale, denial)),
            Phase::Ready(None) => C::Gone(data::gone(locale)),
            Phase::Ready(Some((sheet, today))) => {
                C::Data(Box::new(data::person(locale, sheet, today)))
            }
        };
        let state = wire::PeoplePersonState {
            party_id: self.party_id.clone(),
            name_hint: self.name_hint.clone(),
            chrome: Some(Self::chrome(locale)),
            content: Some(content),
            sheet: self.sheet.as_ref().map(|sheet| sheet.view(locale)),
            confirm: self.confirm(locale),
            status: self.status.clone(),
            done: self.done,
            edit: self.loaded().map(|_| routes::editor(&self.party_id)),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PeoplePerson(Box::new(state))),
            ..wire::ViewState::default()
        }
    }
}
