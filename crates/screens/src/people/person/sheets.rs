//! THE WRITE SHEETS OVER ONE PERSON: Log a touch, Add note, Add date, Add
//! channel and the Merge choices. Each holds the fields the member typed; a
//! refused write keeps them with the core's sentence over them.

use centraid_api_proto::core_v1 as wire;

use crate::people::fold;
use crate::strings::{Locale, people as words};

/// A pick among fixed choices: a touch kind, a channel kind.
#[derive(Clone, Debug)]
pub struct Kinds {
    /// The vault's spelling of each choice.
    pub keys: Vec<&'static str>,
    pub picked: usize,
}

impl Kinds {
    fn of(locale: Locale, choices: &[(&'static str, String)]) -> Self {
        let _ = locale;
        Self {
            keys: choices.iter().map(|(key, _)| *key).collect(),
            picked: 0,
        }
    }

    pub fn key(&self) -> &'static str {
        self.keys[self.picked]
    }

    pub fn pick(&mut self, key: &str) {
        if let Some(at) = self.keys.iter().position(|known| *known == key) {
            self.picked = at;
        }
    }

    fn view(&self, choices: Vec<(&'static str, String)>) -> Vec<wire::PeopleKindChoice> {
        choices
            .into_iter()
            .enumerate()
            .map(|(at, (key, label))| wire::PeopleKindChoice {
                key: key.to_owned(),
                label,
                selected: at == self.picked,
            })
            .collect()
    }
}

#[derive(Clone, Debug)]
pub struct LogTouch {
    pub kinds: Kinds,
    pub note: String,
}

#[derive(Clone, Debug, Default)]
pub struct Note {
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Date {
    pub label: String,
    pub month_day: String,
    pub reminder_on: bool,
}

#[derive(Clone, Debug)]
pub struct Channel {
    pub kinds: Kinds,
    pub value: String,
    pub label: String,
    pub preferred: bool,
}

/// Who can be folded in, read when the sheet opens.
#[derive(Clone, Debug)]
pub enum Merge {
    Failed,
    Choices(Vec<wire::PeopleRosterRow>),
}

#[derive(Clone, Debug)]
pub enum Form {
    LogTouch(LogTouch),
    Note(Note),
    Date(Date),
    Channel(Channel),
    Merge(Merge),
}

/// The sheet on screen: its form, and the refusal of the write it last made.
#[derive(Clone, Debug)]
pub struct Sheet {
    pub form: Form,
    pub failure: Option<String>,
}

impl Sheet {
    pub fn log_touch(locale: Locale) -> Self {
        Self::of(Form::LogTouch(LogTouch {
            kinds: Kinds::of(locale, &fold::log_kinds(locale)),
            note: String::new(),
        }))
    }

    pub fn note() -> Self {
        Self::of(Form::Note(Note::default()))
    }

    pub fn date() -> Self {
        Self::of(Form::Date(Date {
            label: String::new(),
            month_day: String::new(),
            reminder_on: true,
        }))
    }

    pub fn channel(locale: Locale) -> Self {
        Self::of(Form::Channel(Channel {
            kinds: Kinds::of(locale, &fold::channel_kinds(locale)),
            value: String::new(),
            label: String::new(),
            preferred: false,
        }))
    }

    pub fn merge(merge: Merge) -> Self {
        Self::of(Form::Merge(merge))
    }

    fn of(form: Form) -> Self {
        Self {
            form,
            failure: None,
        }
    }

    /// A field edit clears the last refusal: the member is answering it.
    pub fn kind_picked(&mut self, key: &str) {
        self.failure = None;
        match &mut self.form {
            Form::LogTouch(form) => form.kinds.pick(key),
            Form::Channel(form) => form.kinds.pick(key),
            _ => {}
        }
    }

    /// The first text: the touch note, the note, the date's label, the channel's value.
    pub fn text(&mut self, text: String) {
        self.failure = None;
        match &mut self.form {
            Form::LogTouch(form) => form.note = text,
            Form::Note(form) => form.text = text,
            Form::Date(form) => form.label = text,
            Form::Channel(form) => form.value = text,
            Form::Merge(_) => {}
        }
    }

    /// The second text: the date's `MM-DD`, the channel's label.
    pub fn second_text(&mut self, text: String) {
        self.failure = None;
        match &mut self.form {
            Form::Date(form) => form.month_day = text.trim().to_owned(),
            Form::Channel(form) => form.label = text,
            _ => {}
        }
    }

    /// The switch: the date's reminder, the channel's preferred.
    pub fn flag(&mut self) {
        self.failure = None;
        match &mut self.form {
            Form::Date(form) => form.reminder_on = !form.reminder_on,
            Form::Channel(form) => form.preferred = !form.preferred,
            _ => {}
        }
    }

    /// May the member submit what is typed?
    pub fn can_submit(&self) -> bool {
        match &self.form {
            Form::LogTouch(_) => true,
            Form::Note(form) => !form.text.trim().is_empty(),
            Form::Date(form) => {
                !form.label.trim().is_empty() && fold::valid_month_day(&form.month_day)
            }
            Form::Channel(form) => !form.value.trim().is_empty(),
            Form::Merge(_) => false,
        }
    }

    fn frame(&self, locale: Locale, title: String, submit: String) -> wire::PeopleSheetFrame {
        wire::PeopleSheetFrame {
            title,
            submit_label: submit,
            submit_enabled: self.can_submit(),
            cancel_label: words::cancel(locale),
            failure: self.failure.as_ref().map(|sentence| wire::Failure {
                sentence: sentence.clone(),
                remedy: String::new(),
            }),
        }
    }

    pub fn view(&self, locale: Locale) -> wire::PeoplePersonSheet {
        use wire::people_person_sheet::Kind as K;
        let kind = match &self.form {
            Form::LogTouch(form) => K::LogTouch(wire::PeopleLogTouchSheet {
                frame: Some(self.frame(locale, words::log_touch(locale), words::log(locale))),
                kinds: form.kinds.view(fold::log_kinds(locale)),
                note: form.note.clone(),
                note_label: words::note_label(locale),
                note_placeholder: words::note_placeholder(locale),
                hint: words::log_hint(locale),
            }),
            Form::Note(form) => K::Note(wire::PeopleNoteSheet {
                frame: Some(self.frame(locale, words::add_note(locale), words::add(locale))),
                text: form.text.clone(),
                placeholder: words::note_sheet_placeholder(locale),
            }),
            Form::Date(form) => K::Date(wire::PeopleDateSheet {
                frame: Some(self.frame(locale, words::add_date(locale), words::add(locale))),
                label: form.label.clone(),
                label_field: words::date_label_field(locale),
                month_day: form.month_day.clone(),
                month_day_field: words::date_field(locale),
                month_day_placeholder: words::date_placeholder(locale),
                // SAID ONLY ONCE THERE IS SOMETHING TO BE WRONG ABOUT.
                month_day_invalid: if form.month_day.chars().count() >= 5
                    && !fold::valid_month_day(&form.month_day)
                {
                    words::date_invalid(locale)
                } else {
                    String::new()
                },
                reminder_on: form.reminder_on,
                reminder_label: words::reminder_on(locale),
            }),
            Form::Channel(form) => K::Channel(wire::PeopleChannelSheet {
                frame: Some(self.frame(locale, words::add_channel(locale), words::save(locale))),
                kinds: form.kinds.view(fold::channel_kinds(locale)),
                value: form.value.clone(),
                value_field: words::channel_value_field(locale),
                label: form.label.clone(),
                label_field: words::channel_label_field(locale),
                preferred: form.preferred,
                preferred_label: words::channel_preferred(locale),
            }),
            Form::Merge(merge) => K::Merge(wire::PeopleMergeSheet {
                title: words::merge_title(locale),
                body: words::merge_body(locale),
                cancel_label: words::cancel(locale),
                content: Some(match merge {
                    Merge::Failed => wire::people_merge_sheet::Content::Failure(
                        crate::kit::read::failure(locale),
                    ),
                    Merge::Choices(people) => {
                        wire::people_merge_sheet::Content::Choices(wire::PeopleMergeChoices {
                            choices: people
                                .iter()
                                .map(|row| wire::PeopleMergeChoice {
                                    party_id: row.party_id.clone(),
                                    name: row.name.clone(),
                                    avatar: Some(fold::avatar(&row.party_id, &row.name)),
                                    role: row.role.clone(),
                                })
                                .collect(),
                            empty: people.is_empty().then(|| wire::EmptyState {
                                headline: words::empty_merge(locale),
                                ..wire::EmptyState::default()
                            }),
                        })
                    }
                }),
            }),
        };
        wire::PeoplePersonSheet { kind: Some(kind) }
    }
}
