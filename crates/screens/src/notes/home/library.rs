//! THE NOTES PLACE: the live shelf, pinned first, with search as a field over it,
//! sort and filters as the read's parameters, and a row menu that pins, files
//! into a notebook and trashes.
//!
//! THE ROOM'S GRAMMAR (R-CHROME-1…4): New note is the header's one action next to
//! the filter button, search the bar under it, and More holds Import, Export and Trash — never
//! search, sort or a filter. The button opens ONE menu ([`Library::filter_menu`]:
//! Pinned and the tags to show, the order to sort by), and the notebook the
//! library was opened on is the title's second line ([`Library::subtitle`]), whose
//! close key shows every note.
//!
//! - **Reads** are `notes.library` (its notebooks are the file-into sheet's
//!   choices), or `notes.search` while a term is typed. Search lives beside the
//!   library, so closing it puts the library back.
//! - **Writes** are one at a time and synchronous; the load after each write
//!   shows what committed and never moves a row on a guess.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::load;
use crate::kit::menu;
use crate::kit::read::{self, Note, Page, Reading};
use crate::kit::search;
use crate::notes::{denied, fold, routes};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, notes as words};

/// The core's default window, and its ceiling.
const DEFAULT_WINDOW: u32 = 200;
const MAX_WINDOW: u32 = 2000;

/// The filter section's key (`notes-filter-show-pinned` on a screen), its Pinned
/// option, and the prefix a tag's option key carries before the concept id.
pub(super) const FILTER: &str = "show";
pub(super) const FILTER_PINNED: &str = "pinned";
pub(super) const FILTER_TAG: &str = "tag-";
/// The About options: the notes about a person, the notes about an event (#1173).
pub(super) const FILTER_ABOUT_PEOPLE: &str = "about-people";
pub(super) const FILTER_ABOUT_EVENTS: &str = "about-events";

/// The sort section's options (`notes-filter-sort-updated`).
const SORT_UPDATED: &str = "updated";
const SORT_CREATED: &str = "created";
const SORT_TITLE: &str = "title";

/// The search field and its answer.
#[derive(Default)]
pub(super) struct Search {
    pub open: bool,
    pub term: String,
    /// The answer for the trimmed `term`, once there is one to ask. A search that matched
    /// nothing is [`Page::Empty`], never ready data.
    pub held: Option<Page<wire::NotesSearch>>,
    /// The trimmed term `held` answers: a read of a new term that fails is the failure, not the
    /// last term's rows under a note.
    answered: String,
}

/// Did the search match nothing? A notebook whose name matched is an answer (#1097).
fn matched_nothing(found: &wire::NotesSearch) -> bool {
    found.hits.is_empty()
        && !found
            .containers
            .iter()
            .any(|hit| hit.entity == "notebook" && hit.app_id == "notes")
}

/// Does a row pass the About options? With neither on, every row does.
fn passes(about_people: bool, about_events: bool, row: &wire::NotesRow) -> bool {
    (!about_people && !about_events)
        || row.about.iter().any(|card| {
            (about_people && card.entity == "person") || (about_events && card.entity == "event")
        })
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
    /// Only the notes about a person, and/or about an event (either, when both are on).
    pub about_people: bool,
    pub about_events: bool,
    pub notebook_id: String,
    pub notebook_name: String,
    pub unfiled_only: bool,
    /// The read. Nothing the filters leave is [`Page::Empty`] (see [`Library::wire`]).
    pub page: Page<wire::NotesLibrary>,
    /// What the read was asked for, apart from its window: data read for another filter, sort
    /// or notebook is not shown under a failed read of this one.
    asked: String,
    /// The tags the window saw, from the last answer that came (the filter menu's options stay
    /// while a filter leaves nothing).
    tags: Vec<wire::NotesTagFacet>,
    pub search: Search,
}

impl Library {
    pub fn new(notebook_id: &str, notebook_name: &str, unfiled_only: bool) -> Self {
        Self {
            window: 0,
            sort: wire::NotesLibrarySort::Updated,
            pinned_only: false,
            tag_ids: Vec::new(),
            about_people: false,
            about_events: false,
            notebook_id: notebook_id.to_owned(),
            notebook_name: notebook_name.to_owned(),
            unfiled_only: unfiled_only && notebook_id.is_empty(),
            page: Page::loading(),
            asked: String::new(),
            tags: Vec::new(),
            search: Search::default(),
        }
    }

    pub fn reload(&mut self, ctx: &Ctx) {
        self.read(ctx, false);
    }

    /// The read the shelf was last asked for, without its window.
    fn query_key(&self) -> String {
        format!(
            "{}/{}/{}/{}/{}",
            sort_key(self.sort),
            self.pinned_only,
            self.tag_ids.join(","),
            self.notebook_id,
            self.unfiled_only && self.notebook_id.is_empty()
        )
    }

    /// Read the shelf (or search's answer); `wider` says the window grew, so a read that did not
    /// come keeps the rows already shown under the "more did not load" note.
    fn read(&mut self, ctx: &Ctx, wider: bool) {
        if self.search.active() {
            self.read_search(ctx);
            return;
        }
        let sort = sort_key(self.sort);
        let request = load::notes::Library {
            limit: self.window,
            notebook_id: Some(self.notebook_id.clone()).filter(|id| !id.is_empty()),
            pinned_only: self.pinned_only.then_some(1),
            sort: Some(sort.to_owned()),
            tag_concept_ids: (!self.tag_ids.is_empty())
                .then(|| serde_json::to_string(&self.tag_ids).unwrap_or_default()),
            unfiled_only: (self.unfiled_only && self.notebook_id.is_empty()).then_some(1),
        };
        let reading = read::read(ctx, request, |answer| match answer {
            Answer::NotesLibrary(library) => Some(library),
            _ => None,
        });
        self.landed(ctx.locale(), reading, wider);
    }

    /// The page after `reading` landed over the one before. A refresh never blanks the rows
    /// shown (a failed one keeps them under a note); a read for another filter, sort or notebook
    /// starts from nothing, so a failure of it is the failure and never the old rows.
    fn landed(&mut self, locale: Locale, reading: Reading<wire::NotesLibrary>, wider: bool) {
        if let Reading::Data(library) = &reading {
            self.tags.clone_from(&library.tags);
        }
        let key = self.query_key();
        let kept = std::mem::replace(&mut self.page, Page::loading());
        let held = if self.asked == key {
            kept.refreshing()
        } else {
            Page::loading()
        };
        self.asked = key;
        let (people, events) = (self.about_people, self.about_events);
        self.page = match (held, reading) {
            (Page::Ready { data, .. }, Reading::Failed) if wider => Page::Ready {
                data,
                note: Some(Note::more_failed(locale)),
            },
            (held, reading) => held.after(reading, locale, |library| {
                !library.notes.iter().any(|row| passes(people, events, row))
            }),
        };
    }

    fn read_search(&mut self, ctx: &Ctx) {
        let term = self.search.term.trim().to_owned();
        let reading =
            read::read(
                ctx,
                load::notes::Search { term: term.clone() },
                |answer| match answer {
                    Answer::NotesSearch(found) => Some(found),
                    _ => None,
                },
            );
        let held = match self.search.held.take() {
            Some(held) if self.search.answered == term => held.refreshing(),
            _ => Page::loading(),
        };
        self.search.answered = term;
        self.search.held = Some(held.after(reading, ctx.locale(), matched_nothing));
    }

    pub fn search_opened(&mut self) {
        self.search.open = true;
    }

    pub fn search_term(&mut self, ctx: &Ctx, term: String) {
        self.search.open = true;
        self.search.term = term;
        if self.search.active() {
            self.read_search(ctx);
        } else {
            self.search.held = None;
        }
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
        self.read(ctx, true);
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

    pub fn toggle_about(&mut self, ctx: &Ctx, events: bool) {
        if events {
            self.about_events = !self.about_events;
        } else {
            self.about_people = !self.about_people;
        }
        self.reload(ctx);
    }

    /// Whether a row passes the About options: with neither on, every row does.
    fn shows(&self, row: &wire::NotesRow) -> bool {
        passes(self.about_people, self.about_events, row)
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

    /// "Clear filters": Pinned and the tags go; the notebook it was opened on and
    /// the order stay (the notebook has its own close key, a sort is no filter).
    pub fn clear_filters(&mut self, ctx: &Ctx) {
        if !self.pinned_only && self.tag_ids.is_empty() && !self.about_people && !self.about_events
        {
            return;
        }
        self.pinned_only = false;
        self.about_people = false;
        self.about_events = false;
        self.tag_ids.clear();
        self.reload(ctx);
    }

    /// The subtitle's close key widens to every note.
    pub fn clear_notebook(&mut self, ctx: &Ctx) {
        self.notebook_id.clear();
        self.notebook_name.clear();
        self.unfiled_only = false;
        self.reload(ctx);
    }

    /// The notebook the library is scoped to, in a word: its name, or "Unfiled".
    fn scope_label(&self, locale: Locale) -> Option<String> {
        if !self.notebook_id.is_empty() {
            Some(if self.notebook_name.is_empty() {
                words::untitled_notebook(locale)
            } else {
                self.notebook_name.clone()
            })
        } else if self.unfiled_only {
            Some(words::unfiled_row(locale))
        } else {
            None
        }
    }

    /// Does the library offer its menu and subtitle? Not while denied, and not
    /// over search, whose results no filter narrows and no notebook scopes.
    fn offers_chrome(&self) -> bool {
        !matches!(self.page, Page::Refused(_)) && !self.search.open
    }

    /// THE TITLE'S SECOND LINE: the notebook (or "Unfiled") the library was
    /// opened on, with a close key that shows every note. The page's title stays
    /// "Notes" while scoped. None when the library is not scoped.
    pub fn subtitle(&self, locale: Locale) -> Option<wire::HeaderSubtitle> {
        if !self.offers_chrome() {
            return None;
        }
        let label = self.scope_label(locale)?;
        Some(wire::HeaderSubtitle {
            spoken: fill(&words::notebook_scope(locale), &[("name", &label)]),
            label,
            clearable: true,
            clear_spoken: words::show_every_note(locale),
            tappable: false,
        })
    }

    /// A note on screen — the library's or search's — by id: its pin and notebook.
    pub fn find(&self, locale: Locale, note_id: &str) -> Option<Found> {
        let searched = if self.search.active() {
            self.search.held.as_ref()
        } else {
            None
        };
        if let Some(found) = searched.and_then(Page::data)
            && let Some(hit) = found.hits.iter().find(|hit| hit.note_id == note_id)
        {
            return Some(Found {
                title: fold::title_of(locale, hit.title.as_deref(), &hit.preview),
                pinned: hit.pinned,
                notebook_id: hit.notebook_ids.first().cloned().unwrap_or_default(),
            });
        }
        let library = self.page.data()?;
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
            || self.about_people
            || self.about_events
    }

    /// THE HEADER'S FILTER BUTTON: Pinned and the tags the window saw (any number
    /// on, the filter), then the sort (one of three). Lit while Pinned or a tag
    /// narrows the shelf; the notebook scope is the subtitle's, and a sort is no
    /// filter. None while denied and over search.
    pub fn filter_menu(&self, locale: Locale) -> Option<wire::FilterMenu> {
        if !self.offers_chrome() {
            return None;
        }
        let mut shown = vec![menu::option(
            FILTER_PINNED,
            words::filter_pinned(locale),
            self.pinned_only,
        )];
        shown.extend(self.tags.iter().map(|tag| {
            menu::option(
                format!("{FILTER_TAG}{}", tag.concept_id),
                tag.label.clone(),
                self.tag_ids.contains(&tag.concept_id),
            )
        }));
        shown.push(menu::option(
            FILTER_ABOUT_PEOPLE,
            words::filter_about_people(locale),
            self.about_people,
        ));
        shown.push(menu::option(
            FILTER_ABOUT_EVENTS,
            words::filter_about_events(locale),
            self.about_events,
        ));
        let order = sorts(locale)
            .into_iter()
            .map(|(sort, label)| menu::option(sort_key(sort), label, sort == self.sort))
            .collect();
        Some(menu::menu(
            locale,
            vec![
                menu::multi(FILTER, words::filter_title(locale), shown),
                menu::single(menu::SORT, words::sort_title(locale), order),
            ],
            self.pinned_only || !self.tag_ids.is_empty() || self.about_people || self.about_events,
        ))
    }

    /// A pick in the menu: Pinned and a tag toggle themselves, a sort sets the
    /// order. Nothing while the menu is not offered, or for a key it did not make.
    pub fn pick(&mut self, ctx: &Ctx, pick: menu::Pick<'_>) {
        if !self.offers_chrome() {
            return;
        }
        match (pick.section, pick.option) {
            (FILTER, FILTER_PINNED) => self.toggle_pinned(ctx),
            (FILTER, FILTER_ABOUT_PEOPLE) => self.toggle_about(ctx, false),
            (FILTER, FILTER_ABOUT_EVENTS) => self.toggle_about(ctx, true),
            (FILTER, tag) => {
                if let Some(concept_id) = tag.strip_prefix(FILTER_TAG) {
                    self.toggle_tag(ctx, concept_id);
                }
            }
            (menu::SORT, order) => {
                if let Some(sort) = sort_of(order) {
                    self.set_sort(ctx, sort);
                }
            }
            _ => {}
        }
    }

    /// Does the shelf, as the filters leave it, hold nothing? Ready means there is something to
    /// show: this is [`Page::Empty`] on the wire.
    fn nothing_shown(&self) -> bool {
        matches!(&self.page, Page::Ready { data, .. } if !data.notes.iter().any(|row| self.shows(row)))
    }

    /// THE PAGE'S READ: over an open search it is the search's (nothing typed is ready, with the
    /// hint under the field); otherwise the shelf's, where nothing the filters leave is the empty
    /// state with the sentence for why.
    pub fn wire(&self, locale: Locale) -> wire::PageState {
        let gate = |denial: &wire::AppQueryDenial| denied(locale, denial);
        if self.search.open {
            return match (&self.search.held, self.search.active()) {
                (Some(held), true) => held.wire(locale, gate, || no_match(locale)),
                _ => Page::<()>::Ready {
                    data: (),
                    note: None,
                }
                .wire(locale, gate, wire::EmptyState::default),
            };
        }
        if self.nothing_shown() {
            return Page::<()>::Empty.wire(locale, gate, || self.empty_state(locale));
        }
        self.page.wire(locale, gate, || self.empty_state(locale))
    }

    /// What the shelf draws when it is ready and has something to show.
    pub fn shelf(&self, locale: Locale) -> Option<wire::NotesLibraryData> {
        if self.nothing_shown() {
            return None;
        }
        self.page.data().map(|library| self.data(locale, library))
    }

    /// THE EMPTY SHELF'S SENTENCE: day one, a notebook with nothing in it, or filters that leave
    /// nothing.
    fn empty_state(&self, locale: Locale) -> wire::EmptyState {
        if !self.notebook_id.is_empty() {
            wire::EmptyState {
                headline: words::empty_filtered_headline(locale),
                body: words::empty_notebook_body(locale),
                action_label: words::new_note(locale),
                ..wire::EmptyState::default()
            }
        } else if self.filtered() {
            wire::EmptyState {
                headline: words::empty_filtered_headline(locale),
                body: words::empty_filtered_body(locale),
                ..wire::EmptyState::default()
            }
        } else {
            // DAY ONE: nothing written yet, and one action that takes content.
            wire::EmptyState {
                headline: words::empty_day_one_headline(locale),
                body: words::empty_day_one(locale),
                action_label: words::new_note(locale),
                ..wire::EmptyState::default()
            }
        }
    }

    fn data(&self, locale: Locale, library: &wire::NotesLibrary) -> wire::NotesLibraryData {
        let rows: Vec<wire::NotesNoteRow> = library
            .notes
            .iter()
            .filter(|row| self.shows(row))
            .map(|row| fold::row(locale, row))
            .collect();
        let count = rows.len();
        let window = if self.window == 0 {
            DEFAULT_WINDOW
        } else {
            self.window
        };
        wire::NotesLibraryData {
            sections: fold::sections(locale, rows),
            count_label: fold::notes_count(locale, count, false),
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
                hint: words::search_empty(locale),
            });
            return state;
        }
        match &self.search.held {
            Some(Page::Ready { data, .. }) => self.fill(locale, &mut state, data),
            // Nothing matched: the page's Empty state says so, and the ask still closes it.
            Some(Page::Empty) => {
                state.ask = Some(search::offer(locale, &self.search.term, "notes"));
            }
            _ => {}
        }
        state
    }

    /// An answer with something in it: its rows, the notebooks it named, its correction and the
    /// ask.
    fn fill(&self, locale: Locale, state: &mut wire::NotesSearchState, found: &wire::NotesSearch) {
        let rows: Vec<wire::NotesNoteRow> = found
            .hits
            .iter()
            .map(|hit| fold::hit(locale, hit))
            .collect();
        state.results = Some(wire::NotesSearchResults {
            rows,
            hint: String::new(),
        });
        state.containers = containers(locale, &found.containers);
        if !found.corrected.is_empty() {
            state.corrected = search::corrected(locale, &found.corrected);
        }
        state.ask = Some(search::offer(locale, &self.search.term, "notes"));
    }
}

/// NOTHING MATCHED is the page's empty state: the headline and the sentence under it.
fn no_match(locale: Locale) -> wire::EmptyState {
    wire::EmptyState {
        headline: words::search_no_match_headline(locale),
        body: words::search_no_match_body(locale),
        ..wire::EmptyState::default()
    }
}

/// A note on screen, as the menu needs it.
pub(super) struct Found {
    pub title: String,
    pub pinned: bool,
    pub notebook_id: String,
}

/// The sort a menu key names, or None for a key the menu did not make.
fn sort_of(key: &str) -> Option<wire::NotesLibrarySort> {
    match key {
        SORT_UPDATED => Some(wire::NotesLibrarySort::Updated),
        SORT_CREATED => Some(wire::NotesLibrarySort::Created),
        SORT_TITLE => Some(wire::NotesLibrarySort::Title),
        _ => None,
    }
}

/// A sort's key in the menu, which is also the core's name for the order.
fn sort_key(sort: wire::NotesLibrarySort) -> &'static str {
    match sort {
        wire::NotesLibrarySort::Created => SORT_CREATED,
        wire::NotesLibrarySort::Title => SORT_TITLE,
        _ => SORT_UPDATED,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(notebook: &str, unfiled: bool) -> Library {
        let mut library = Library::new(notebook, "Work", unfiled);
        library.page = Page::Ready {
            data: wire::NotesLibrary::default(),
            note: None,
        };
        library
    }

    #[test]
    fn no_menu_and_no_subtitle_while_denied_or_over_search() {
        let locale = Locale::En;
        let library = ready("book-1", false);
        assert!(library.filter_menu(locale).is_some());
        assert!(library.subtitle(locale).is_some());

        let mut denied = ready("book-1", false);
        denied.page = Page::Refused(wire::AppQueryDenial::default());
        assert!(denied.filter_menu(locale).is_none());
        assert!(denied.subtitle(locale).is_none());

        let mut searching = ready("book-1", false);
        searching.search.open = true;
        assert!(searching.filter_menu(locale).is_none());
        assert!(searching.subtitle(locale).is_none());
    }

    #[test]
    fn the_notebook_is_the_subtitle_and_never_a_filter() {
        let locale = Locale::En;
        let scoped = ready("book-1", false);
        let subtitle = scoped.subtitle(locale).expect("a subtitle");
        assert_eq!(subtitle.label, "Work");
        assert_eq!(subtitle.spoken, "Notebook Work");
        assert!(subtitle.clearable && !subtitle.tappable);
        assert_eq!(subtitle.clear_spoken, "Show every note");
        assert!(!scoped.filter_menu(locale).unwrap().filtering);

        // A notebook with no name read yet still has a word.
        let mut unnamed = ready("book-1", false);
        unnamed.notebook_name.clear();
        assert_eq!(unnamed.subtitle(locale).unwrap().label, "Untitled notebook");

        assert_eq!(ready("", true).subtitle(locale).unwrap().label, "Unfiled");
        assert!(ready("", false).subtitle(locale).is_none());
    }

    #[test]
    fn the_filter_is_lit_by_pinned_or_a_tag_only() {
        let locale = Locale::En;
        let mut library = ready("", false);
        assert!(!library.filter_menu(locale).unwrap().filtering);
        library.sort = wire::NotesLibrarySort::Title;
        assert!(!library.filter_menu(locale).unwrap().filtering);
        library.tag_ids.push("t1".to_owned());
        assert!(library.filter_menu(locale).unwrap().filtering);
        library.tag_ids.clear();
        library.pinned_only = true;
        assert!(library.filter_menu(locale).unwrap().filtering);
    }

    fn row_about(id: &str, subjects: &[(&str, &str, &str)]) -> wire::NotesRow {
        wire::NotesRow {
            note_id: id.to_owned(),
            title: Some(id.to_owned()),
            about: subjects
                .iter()
                .map(|(kind, subject, title)| wire::NotesCard {
                    entity: (*kind).to_owned(),
                    id: (*subject).to_owned(),
                    status: "live".to_owned(),
                    title: Some((*title).to_owned()),
                    ..wire::NotesCard::default()
                })
                .collect(),
            ..wire::NotesRow::default()
        }
    }

    #[test]
    fn a_note_about_something_wears_its_subject_and_the_about_options_narrow_the_shelf() {
        let locale = Locale::En;
        let mut library = ready("", false);
        library.page = Page::Ready {
            data: wire::NotesLibrary {
                notes: vec![
                    row_about("plain", &[]),
                    row_about("maya", &[("person", "p1", "Maya")]),
                    row_about("dinner", &[("event", "e1", "Dinner")]),
                ],
                ..wire::NotesLibrary::default()
            },
            note: None,
        };
        let titles = |library: &Library| -> Vec<String> {
            let data = library.shelf(locale).expect("data");
            data.sections
                .iter()
                .flat_map(|section| section.rows.iter())
                .map(|row| row.title.clone())
                .collect()
        };
        let all = library.shelf(locale).expect("data");
        let chips: Vec<(String, String)> = all
            .sections
            .iter()
            .flat_map(|section| section.rows.iter())
            .flat_map(|row| row.about.iter())
            .map(|chip| (chip.label.clone(), chip.route.clone().unwrap().screen))
            .collect();
        assert_eq!(
            chips,
            [
                ("About · Maya".to_owned(), "people.person".to_owned()),
                ("About · Dinner".to_owned(), "calendar.event".to_owned()),
            ]
        );
        assert_eq!(titles(&library).len(), 3);
        library.about_people = true;
        assert_eq!(titles(&library), ["maya"]);
        library.about_events = true;
        assert_eq!(titles(&library).len(), 2, "either, when both are on");
        assert!(library.filter_menu(locale).unwrap().filtering);
        let labels: Vec<String> = library
            .filter_menu(locale)
            .unwrap()
            .sections
            .iter()
            .flat_map(|section| section.options.iter().map(|o| o.label.clone()))
            .collect();
        assert!(labels.contains(&"About people".to_owned()));
        assert!(labels.contains(&"About events".to_owned()));
    }
}
