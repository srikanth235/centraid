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
use crate::kit::civil::{self, HourCycle};
use crate::kit::read::{self, Note, Page, Reading};
use crate::notes::{denied, fold, routes};
use crate::screen::Ctx;
use crate::strings::{Locale, notes as words, shared};

/// The core's default window, and its ceiling.
const DEFAULT_WINDOW: u32 = 200;
const MAX_WINDOW: u32 = 2000;

pub(super) struct Journal {
    pub window: u32,
    pub page: Page<wire::NotesJournal>,
    /// The day the core read as today and the zone it read it in, from the last answer that came.
    /// An empty journal is the page's Empty state and holds no data, but a first entry is filed
    /// on this day all the same.
    clock: Option<(String, String)>,
}

/// No entry on any day: the journal has nothing to show.
fn nothing(journal: &wire::NotesJournal) -> bool {
    journal.days.iter().all(|day| day.entries.is_empty())
}

impl Journal {
    pub fn new() -> Self {
        Self {
            window: 0,
            page: Page::loading(),
            clock: None,
        }
    }

    pub fn reload(&mut self, ctx: &Ctx) {
        self.read(ctx, false);
    }

    /// Read the journal; `wider` says the window grew, so a read that did not come keeps the days
    /// already shown under the "more did not load" note.
    fn read(&mut self, ctx: &Ctx, wider: bool) {
        let reading =
            read::read(
                ctx,
                load::notes::Journal { limit: self.window },
                |answer| match answer {
                    Answer::NotesJournal(journal) => Some(journal),
                    _ => None,
                },
            );
        self.landed(ctx.locale(), reading, wider);
    }

    /// The page after `reading` landed over the one before.
    fn landed(&mut self, locale: Locale, reading: Reading<wire::NotesJournal>, wider: bool) {
        if let Reading::Data(journal) = &reading {
            self.clock = Some((journal.today.clone(), journal.tz.clone()));
        }
        let held = std::mem::replace(&mut self.page, Page::loading());
        self.page = match (held.refreshing(), reading) {
            (Page::Ready { data, .. }, Reading::Failed) if wider => Page::Ready {
                data,
                note: Some(Note::more_failed(locale)),
            },
            (held, reading) => held.after(reading, locale, nothing),
        };
    }

    /// The day and zone a new entry is filed on, once an answer has come (data or an empty
    /// journal); not while the read failed or was refused.
    pub fn clock(&self) -> Option<&(String, String)> {
        match self.page {
            Page::Ready { .. } | Page::Empty => self.clock.as_ref(),
            _ => None,
        }
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
        self.read(ctx, true);
    }

    /// The wire page; an empty journal carries its own sentence.
    pub fn wire(&self, locale: Locale) -> wire::PageState {
        self.page.wire(
            locale,
            |denial| denied(locale, denial),
            || wire::EmptyState {
                headline: words::journal_empty_headline(locale),
                body: words::journal_empty_body(locale),
                ..wire::EmptyState::default()
            },
        )
    }

    /// The core's days, as sections.
    pub fn data(
        locale: Locale,
        _cycle: HourCycle,
        journal: &wire::NotesJournal,
    ) -> wire::NotesJournalData {
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
                        // Journal entries are filed on a day. Their storage timestamp is a
                        // noon anchor, not the time the member wrote the entry.
                        let time = String::new();
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
        wire::NotesJournalData {
            days,
            today: journal.today.clone(),
            tz: journal.tz.clone(),
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
