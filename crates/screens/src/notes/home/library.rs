//! THE NOTES PLACE: the live shelf, pinned first, with search as a field over it,
//! sort and filters as the read's parameters, and a row menu that pins, files
//! into a notebook and trashes.
//!
//! THE ROOM'S GRAMMAR (R-CHROME-1…4): New note is the header's one action,
//! search the bar under it, the filters and the sort ONE chip row ([`chips`]: the
//! notebook it was opened on, Pinned, the tags, the sort last), and More holds
//! Trash alone — never search, sort or a filter.
//!
//! - **Reads** are `notes.library` (its notebooks are the file-into sheet's
//!   choices), or `notes.search` while a term is typed. Search lives beside the
//!   library, so closing it puts the library back.
//! - **Writes** are one at a time and synchronous; the load after each write
//!   shows what committed and never moves a row on a guess.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::load;
use crate::kit::read;
use crate::kit::search;
use crate::notes::{Phase, fold, routes};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, notes as words};

/// The core's default window, and its ceiling.
const DEFAULT_WINDOW: u32 = 200;
const MAX_WINDOW: u32 = 2000;

pub(super) const CHIP_NOTEBOOK: &str = "notebook";
pub(super) const CHIP_PINNED: &str = "pinned";
pub(super) const CHIP_TAG: &str = "tag-";
pub(super) const CHIP_SORT: &str = "sort";

/// The search field and its answer.
#[derive(Default)]
pub(super) struct Search {
    pub open: bool,
    pub term: String,
    /// The answer for the trimmed `term`, once there is one to ask.
    pub held: Option<Phase<wire::NotesSearch>>,
}

impl Search {
    /// Is a term being answered? Then a read is a search.
    pub fn active(&self) -> bool {
        self.open && !self.term.trim().is_empty()
    }
}

pub(super) struct Library {
    pub window: u32,
    pub sort: wire::NotesLibrarySort,
    pub pinned_only: bool,
    pub tag_ids: Vec<String>,
    pub notebook_id: String,
    pub notebook_name: String,
    pub unfiled_only: bool,
    pub phase: Phase<wire::NotesLibrary>,
    pub search: Search,
}

impl Library {
    pub fn new(notebook_id: &str, notebook_name: &str, unfiled_only: bool) -> Self {
        Self {
            window: 0,
            sort: wire::NotesLibrarySort::Updated,
            pinned_only: false,
            tag_ids: Vec::new(),
            notebook_id: notebook_id.to_owned(),
            notebook_name: notebook_name.to_owned(),
            unfiled_only: unfiled_only && notebook_id.is_empty(),
            phase: Phase::Loading,
            search: Search::default(),
        }
    }

    pub fn reload(&mut self, ctx: &Ctx) {
        if self.search.active() {
            self.search.held = Some(self.read_search(ctx));
            return;
        }
        let sort = match self.sort {
            wire::NotesLibrarySort::Created => "created",
            wire::NotesLibrarySort::Title => "title",
            _ => "updated",
        };
        let request = load::notes::Library {
            limit: self.window,
            notebook_id: Some(self.notebook_id.clone()).filter(|id| !id.is_empty()),
            pinned_only: self.pinned_only.then_some(1),
            sort: Some(sort.to_owned()),
            tag_concept_ids: (!self.tag_ids.is_empty())
                .then(|| serde_json::to_string(&self.tag_ids).unwrap_or_default()),
            unfiled_only: (self.unfiled_only && self.notebook_id.is_empty()).then_some(1),
        };
        // The rows stay drawn while a refresh reads (a synchronous read leaves no gap).
        self.phase = Phase::of(read::read(ctx, request, |answer| match answer {
            Answer::NotesLibrary(library) => Some(library),
            _ => None,
        }));
    }

    fn read_search(&self, ctx: &Ctx) -> Phase<wire::NotesSearch> {
        Phase::of(read::read(
            ctx,
            load::notes::Search {
                term: self.search.term.trim().to_owned(),
            },
            |answer| match answer {
                Answer::NotesSearch(found) => Some(found),
                _ => None,
            },
        ))
    }

    pub fn search_opened(&mut self) {
        self.search.open = true;
    }

    pub fn search_term(&mut self, ctx: &Ctx, term: String) {
        self.search.open = true;
        self.search.term = term;
        self.search.held = if self.search.active() {
            Some(self.read_search(ctx))
        } else {
            None
        };
    }

    /// CLOSE CLEARS the term and its answer; the library comes back.
    pub fn search_closed(&mut self, ctx: &Ctx) {
        self.search = Search::default();
        self.reload(ctx);
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

    pub fn toggle_tag(&mut self, ctx: &Ctx, concept_id: &str) {
        match self.tag_ids.iter().position(|id| id == concept_id) {
            Some(at) => {
                self.tag_ids.remove(at);
            }
            None => self.tag_ids.push(concept_id.to_owned()),
        }
        self.reload(ctx);
    }

    pub fn toggle_pinned(&mut self, ctx: &Ctx) {
        self.pinned_only = !self.pinned_only;
        self.reload(ctx);
    }

    pub fn set_sort(&mut self, ctx: &Ctx, sort: wire::NotesLibrarySort) {
        self.sort = match sort {
            wire::NotesLibrarySort::Unspecified => wire::NotesLibrarySort::Updated,
            sort => sort,
        };
        self.reload(ctx);
    }

    /// The notebook chip widens to every note.
    pub fn clear_notebook(&mut self, ctx: &Ctx) {
        self.notebook_id.clear();
        self.notebook_name.clear();
        self.unfiled_only = false;
        self.reload(ctx);
    }

    /// The heading: the notebook, "Unfiled", or "Notes".
    pub fn heading(&self, locale: Locale) -> String {
        if !self.notebook_id.is_empty() {
            if self.notebook_name.is_empty() {
                words::title(locale)
            } else {
                self.notebook_name.clone()
            }
        } else if self.unfiled_only {
            words::unfiled_row(locale)
        } else {
            words::title(locale)
        }
    }

    /// A note on screen — the library's or search's — by id: its pin and notebook.
    pub fn find(&self, locale: Locale, note_id: &str) -> Option<Found> {
        let searched = if self.search.active() { self.search.held.as_ref() } else { None };
        if let Some(Phase::Ready(found)) = searched {
            if let Some(hit) = found.hits.iter().find(|hit| hit.note_id == note_id) {
                return Some(Found {
                    title: fold::title_of(locale, hit.title.as_deref(), &hit.preview),
                    pinned: hit.pinned,
                    notebook_id: hit.notebook_ids.first().cloned().unwrap_or_default(),
                });
            }
        }
        let library = self.phase.data()?;
        let row = library.notes.iter().find(|row| row.note_id == note_id)?;
        Some(Found {
            title: fold::title_of(locale, row.title.as_deref(), &row.preview),
            pinned: row.pinned,
            notebook_id: row.notebook_ids.first().cloned().unwrap_or_default(),
        })
    }

    /// Whether the shelf has anything filtering it.
    fn filtered(&self) -> bool {
        self.pinned_only
            || self.unfiled_only
            || !self.notebook_id.is_empty()
            || !self.tag_ids.is_empty()
    }

    /// The sort sheet's choices, the current order marked.
    pub fn sort_choices(&self, locale: Locale) -> Vec<wire::NotesChoice> {
        sorts(locale)
            .into_iter()
            .map(|(sort, label)| wire::NotesChoice {
                id: format!("{sort:?}"),
                label,
                selected: sort == self.sort,
                sort: sort as i32,
            })
            .collect()
    }

    /// THE CHIP ROW, in draw order: the notebook the library was opened on
    /// (selected — a tap widens to every note), Pinned, the tags the window saw,
    /// then the sort, last, wearing the current order's name. None while
    /// denied, and none over search, whose results no filter narrows.
    pub fn chips(&self, locale: Locale) -> Vec<wire::NotesChip> {
        if matches!(self.phase, Phase::Denied(_)) || self.search.open {
            return Vec::new();
        }
        let mut chips = Vec::new();
        if !self.notebook_id.is_empty() || self.unfiled_only {
            chips.push(wire::NotesChip {
                key: CHIP_NOTEBOOK.to_owned(),
                label: self.heading(locale),
                selected: true,
                ..wire::NotesChip::default()
            });
        }
        chips.push(wire::NotesChip {
            key: CHIP_PINNED.to_owned(),
            label: words::chip_pinned(locale),
            selected: self.pinned_only,
            ..wire::NotesChip::default()
        });
        if let Some(library) = self.phase.data() {
            for tag in &library.tags {
                chips.push(wire::NotesChip {
                    key: format!("{CHIP_TAG}{}", tag.concept_id),
                    label: tag.label.clone(),
                    selected: self.tag_ids.contains(&tag.concept_id),
                    ..wire::NotesChip::default()
                });
            }
        }
        let order = sorts(locale)
            .into_iter()
            .find(|(sort, _)| *sort == self.sort)
            .map_or_else(|| words::sort_updated(locale), |(_, label)| label);
        chips.push(wire::NotesChip {
            key: CHIP_SORT.to_owned(),
            spoken: fill(&words::sort_chip_spoken(locale), &[("order", &order)]),
            label: order,
            chevron: true,
            ..wire::NotesChip::default()
        });
        chips
    }

    /// What the place draws: the library, or search's failure or gate.
    pub fn content(&self, locale: Locale) -> Content {
        // A search that did not land replaces the shelf: it is not an empty one.
        if self.search.active() {
            match &self.search.held {
                Some(Phase::Failed) => return Content::Failed,
                Some(Phase::Denied(denial)) => return Content::Denied(denial.clone()),
                _ => {}
            }
        }
        match &self.phase {
            Phase::Loading => Content::Loading,
            Phase::Failed => Content::Failed,
            Phase::Denied(denial) => Content::Denied(denial.clone()),
            Phase::Ready(library) => Content::Data(self.data(locale, library)),
        }
    }

    fn data(&self, locale: Locale, library: &wire::NotesLibrary) -> wire::NotesLibraryData {
        let rows: Vec<wire::NotesNoteRow> = library
            .notes
            .iter()
            .map(|row| fold::row(locale, row))
            .collect();
        let count = rows.len();
        let empty = if count > 0 {
            None
        } else if !self.notebook_id.is_empty() {
            Some(wire::EmptyState {
                headline: words::empty_filtered_headline(locale),
                body: words::empty_notebook_body(locale),
                action_label: words::new_note(locale),
                ..wire::EmptyState::default()
            })
        } else if self.filtered() {
            Some(wire::EmptyState {
                headline: words::empty_filtered_headline(locale),
                body: words::empty_filtered_body(locale),
                ..wire::EmptyState::default()
            })
        } else {
            // DAY ONE: nothing written yet, and one action that takes content.
            Some(wire::EmptyState {
                headline: words::empty_day_one_headline(locale),
                body: words::empty_day_one(locale),
                action_label: words::new_note(locale),
                ..wire::EmptyState::default()
            })
        };
        let window = if self.window == 0 { DEFAULT_WINDOW } else { self.window };
        wire::NotesLibraryData {
            sections: fold::sections(locale, rows),
            tags: library
                .tags
                .iter()
                .map(|tag| wire::NotesTagChip {
                    concept_id: tag.concept_id.clone(),
                    label: tag.label.clone(),
                    selected: self.tag_ids.contains(&tag.concept_id),
                })
                .collect(),
            count_label: fold::notes_count(locale, count, false),
            empty,
            truncated: library.truncated,
            window_end_label: if library.truncated {
                words::window_end_label(locale)
            } else {
                String::new()
            },
            window_end_verb: if library.truncated {
                words::window_end_verb(locale)
            } else {
                String::new()
            },
            can_widen: library.truncated && window < MAX_WINDOW,
        }
    }

    /// The search field's state: the typed term, the answer's rows, the
    /// notebooks it named, the correction and the Ask row.
    pub fn search_state(&self, locale: Locale) -> wire::NotesSearchState {
        let mut state = wire::NotesSearchState {
            open: self.search.open,
            term: self.search.term.clone(),
            ..wire::NotesSearchState::default()
        };
        if !self.search.open {
            return state;
        }
        if !self.search.active() {
            state.results = Some(wire::NotesSearchResults {
                rows: Vec::new(),
                empty: Some(wire::EmptyState {
                    body: words::search_empty(locale),
                    ..wire::EmptyState::default()
                }),
                loading: false,
            });
            return state;
        }
        let Some(Phase::Ready(found)) = &self.search.held else {
            return state;
        };
        let rows: Vec<wire::NotesNoteRow> = found.hits.iter().map(|hit| fold::hit(locale, hit)).collect();
        let containers = containers(locale, &found.containers);
        // A NOTEBOOK THAT MATCHED IS AN ANSWER: no "nothing found" over it.
        let empty = (rows.is_empty() && containers.is_empty()).then(|| wire::EmptyState {
            headline: words::search_no_match_headline(locale),
            body: words::search_no_match_body(locale),
            ..wire::EmptyState::default()
        });
        state.results = Some(wire::NotesSearchResults {
            rows,
            empty,
            loading: false,
        });
        state.containers = containers;
        if !found.corrected.is_empty() {
            state.corrected = search::corrected(locale, &found.corrected);
        }
        state.ask = Some(search::offer(locale, &self.search.term, "notes"));
        state
    }
}

/// A note on screen, as the menu needs it.
pub(super) struct Found {
    pub title: String,
    pub pinned: bool,
    pub notebook_id: String,
}

/// What the Notes place draws.
pub(super) enum Content {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Data(wire::NotesLibraryData),
}

fn sorts(locale: Locale) -> [(wire::NotesLibrarySort, String); 3] {
    [
        (wire::NotesLibrarySort::Updated, words::sort_updated(locale)),
        (wire::NotesLibrarySort::Created, words::sort_created(locale)),
        (wire::NotesLibrarySort::Title, words::sort_title_az(locale)),
    ]
}

/// The notebooks a search term named, as the kit's containers.
fn containers(locale: Locale, hits: &[wire::ContainerHit]) -> Vec<wire::SearchContainer> {
    hits.iter()
        .filter(|hit| hit.entity == "notebook" && hit.app_id == "notes")
        .map(|hit| {
            let kind_label = crate::strings::shared::search_kind_notebook(locale);
            wire::SearchContainer {
                entity: hit.entity.clone(),
                id: hit.id.clone(),
                app_id: hit.app_id.clone(),
                accessibility_label: [kind_label.as_str(), hit.title.as_str()]
                    .into_iter()
                    .filter(|part| !part.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(", "),
                kind_label,
                title: hit.title.clone(),
                icon_key: "Book".to_owned(),
                route: Some(routes::home(
                    wire::NotesPlace::Notes,
                    &hit.id,
                    &hit.title,
                    false,
                )),
            }
        })
        .collect()
}
