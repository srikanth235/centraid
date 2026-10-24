//! THE JOURNAL PLACE: People-journal entries grouped by the LOCAL day each was
//! written on, newest first — the core's grouping, in the device's zone, so
//! "Today" is the core's today and never a UTC guess.
//!
//! An entry is a note About the owner that People's action writes, so "New
//! entry for today" opens the journal's own sheet and Save is
//! `people.add-journal-entry{mood, text, entry_date, tz}` — the one action that
//! makes an entry a journal entry. A plain new note would land in the library.
//! `tz` is the zone the core read `today` in: the entry is filed on that day IN
//! that zone, so east of UTC+11:59 today's entry is not filed under tomorrow.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::load;
use crate::kit::civil;
use crate::kit::read;
use crate::notes::{Phase, fold, routes};
use crate::screen::Ctx;
use crate::strings::{Locale, notes as words, shared};

/// The core's default window, and its ceiling.
const DEFAULT_WINDOW: u32 = 200;
const MAX_WINDOW: u32 = 2000;

pub(super) struct Journal {
    pub window: u32,
    pub phase: Phase<wire::NotesJournal>,
}

impl Journal {
    pub fn new() -> Self {
        Self {
            window: 0,
            phase: Phase::Loading,
        }
    }

    pub fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(read::read(
            ctx,
            load::notes::Journal { limit: self.window },
            |answer| match answer {
                Answer::NotesJournal(journal) => Some(journal),
                _ => None,
            },
        ));
    }

    pub fn widen(&mut self, ctx: &Ctx) {
        let current = if self.window == 0 {
            DEFAULT_WINDOW
        } else {
            self.window
        };
        if current >= MAX_WINDOW {
            return;
        }
        self.window = (current * 2).min(MAX_WINDOW);
        self.reload(ctx);
    }

    /// The core's days, as sections.
    pub fn data(locale: Locale, journal: &wire::NotesJournal) -> wire::NotesJournalData {
        let days: Vec<wire::NotesJournalDaySection> = journal
            .days
            .iter()
            .filter(|day| !day.entries.is_empty())
            .map(|day| wire::NotesJournalDaySection {
                head: Some(wire::NotesSectionHead {
                    title: civil::relative_day(locale, &day.day, &journal.today),
                    count: u32::try_from(day.entries.len()).unwrap_or(u32::MAX),
                }),
                day: day.day.clone(),
                rows: day
                    .entries
                    .iter()
                    .map(|entry| {
                        let title = fold::title_of(locale, entry.title.as_deref(), &entry.preview);
                        let time = if entry.local_time.is_empty() {
                            String::new()
                        } else {
                            civil::clock(&format!("{}T{}", day.day, entry.local_time))
                        };
                        let check = fold::check_label(locale, entry.check_done, entry.check_total);
                        wire::NotesJournalRow {
                            note_id: entry.note_id.clone(),
                            accessibility_label: [title.as_str(), time.as_str(), check.as_str()]
                                .into_iter()
                                .filter(|part| !part.is_empty())
                                .collect::<Vec<_>>()
                                .join(", "),
                            title,
                            meta: time,
                            trailing: check,
                            route: Some(routes::editor(&entry.note_id)),
                        }
                    })
                    .collect(),
            })
            .collect();
        let empty = days.is_empty().then(|| wire::EmptyState {
            headline: words::journal_empty_headline(locale),
            body: words::journal_empty_body(locale),
            ..wire::EmptyState::default()
        });
        wire::NotesJournalData {
            days,
            today: journal.today.clone(),
            tz: journal.tz.clone(),
            empty,
            truncated: journal.truncated,
            window_end_verb: if journal.truncated {
                words::window_end_verb(locale)
            } else {
                String::new()
            },
        }
    }
}

/// The new-entry sheet, while open.
pub(super) struct Compose {
    pub day: String,
    pub tz: String,
    pub mood: String,
    pub text: String,
    pub status: String,
}

impl Compose {
    pub fn can_save(&self) -> bool {
        !self.mood.trim().is_empty() && !self.text.trim().is_empty()
    }

    pub fn view(&self, locale: Locale) -> wire::NotesJournalCompose {
        wire::NotesJournalCompose {
            day: self.day.clone(),
            tz: self.tz.clone(),
            mood: self.mood.clone(),
            text: self.text.clone(),
            status: self.status.clone(),
            title: words::new_entry(locale),
            mood_placeholder: words::journal_mood(locale),
            text_placeholder: words::journal_line(locale),
            save: words::journal_save(locale),
            close: words::close(locale),
            can_save: self.can_save(),
        }
    }

    /// A refused save's words: the core's sentence, else "Not saved".
    pub fn refused(&mut self, locale: Locale, sentence: &str) {
        self.status = if sentence.trim().is_empty() {
            shared::autosave_not_saved(locale)
        } else {
            sentence.to_owned()
        };
    }
}
