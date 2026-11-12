//! THE LIBRARY'S READ: the live photographs (or the favourites) a page at a time,
//! newest first and then the undated tail, which the core's shelf walks as one
//! cursor. A page is read when the end of what is loaded comes into view; a write
//! or a change READS AGAIN IN PLACE: the pages the member had scrolled through are
//! read again into a buffer and swapped in whole, so a favourite neither blanks
//! the grid nor throws the scroll back to the top.
//!
//! A refused FIRST read replaces the library with its sentence (a failed read is
//! not an empty grid). A failed next page or refresh leaves the photographs
//! EXACTLY as they are (still true) under a one-sentence note; a denial is the gate.

use centraid_api_proto::core_v1 as wire;
use wire::PhotosFilter as Filter;
use wire::app_query_response::Answer;

use crate::catalog::load;
use crate::kit::read::{self, Note, Page, Reading};
use crate::screen::Ctx;
use crate::strings::Locale;

/// A mosaic's page: bigger than a list's, still well under the door's clamp.
pub const PAGE: u32 = 120;

#[derive(Debug)]
pub struct Library {
    /// The read's page; the cells below are its data. A library that came back with nothing is
    /// drawn as [`Page::Empty`] by [`Library::drawn`], never as ready data.
    pub page: Page<()>,
    /// Every cell read so far, in the shelf's order, none twice.
    pub cells: Vec<wire::PhotosCell>,
    next: Option<wire::PhotosCursor>,
    /// The shelf's exact size, from the first page.
    pub total: Option<u32>,
    /// A next page was asked for and refused: the library stays, the end is not
    /// known.
    pub more_failed: bool,
}

impl Default for Library {
    fn default() -> Self {
        Self {
            page: Page::loading(),
            cells: Vec::new(),
            next: None,
            total: None,
            more_failed: false,
        }
    }
}

impl Library {
    /// Both walks have ended: every photograph is in `cells`.
    #[must_use]
    pub fn complete(&self) -> bool {
        self.loaded() && self.next.is_none() && !self.more_failed
    }

    #[must_use]
    pub fn loaded(&self) -> bool {
        self.page.data().is_some()
    }

    fn page(
        ctx: &Ctx,
        filter: Filter,
        after: Option<&wire::PhotosCursor>,
    ) -> Reading<wire::PhotosShelf> {
        let view = if filter == Filter::Favorites {
            load::photos::ShelfView::Favorites
        } else {
            load::photos::ShelfView::Live
        };
        read::read(
            ctx,
            load::photos::Shelf {
                limit: PAGE,
                view,
                after: after.map(|cursor| format!("{}\u{1f}{}", cursor.sort_key, cursor.id)),
                id: None,
            },
            |answer| match answer {
                Answer::PhotosShelf(shelf) => Some(*shelf),
                _ => None,
            },
        )
    }

    fn append(&mut self, page: wire::PhotosShelf) {
        let mut known: std::collections::HashSet<String> = self
            .cells
            .iter()
            .map(|cell| cell.photo_id.clone())
            .collect();
        for cell in page.cells {
            if known.insert(cell.photo_id.clone()) {
                self.cells.push(cell);
            }
        }
        self.next = page.next;
    }

    /// The library from its first page: the grid shows skeletons until it lands.
    pub fn first(&mut self, ctx: &Ctx, filter: Filter) {
        *self = Self::default();
        match Self::page(ctx, filter, None) {
            Reading::Data(page) => {
                self.total = page.total;
                self.append(page);
                self.page = ready();
            }
            other => self.unread(&other, ctx.locale()),
        }
    }

    /// A read that did not come: a gate shows the gate; a failure over photographs shown keeps
    /// them under a note, and over nothing shown (an empty library included) is the failure itself.
    pub fn unread(&mut self, reading: &Reading<wire::PhotosShelf>, locale: Locale) {
        let mut held = std::mem::replace(&mut self.page, Page::loading());
        if held.data().is_some() && self.cells.is_empty() && self.next.is_none() {
            held = Page::Empty;
        }
        self.page = match reading {
            Reading::Denied(denial) => Page::Refused(denial.clone()),
            _ => held.after(Reading::Failed, locale, |()| false),
        };
    }

    /// The page as drawn: both walks ended with no photograph is [`Page::Empty`] (ready means
    /// there is something to show); a next page that did not come adds its note over the
    /// photographs.
    #[must_use]
    pub fn drawn(&self, locale: Locale) -> Page<()> {
        if self.page.data().is_some() && self.complete() && self.cells.is_empty() {
            return Page::Empty;
        }
        self.page
            .clone()
            .noted(self.more_failed.then(|| Note::more_failed(locale)))
    }

    /// The next page, appended. A library that has ended asks for nothing.
    pub fn more(&mut self, ctx: &Ctx, filter: Filter) {
        let Some(cursor) = self.next.clone().filter(|_| self.loaded()) else {
            return;
        };
        match Self::page(ctx, filter, Some(&cursor)) {
            Reading::Data(page) => {
                self.more_failed = false;
                self.append(page);
            }
            Reading::Failed => self.more_failed = true,
            other => self.unread(&other, ctx.locale()),
        }
    }

    /// READ AGAIN IN PLACE: as many pages as the member had scrolled through,
    /// swapped in whole. A failed read leaves the photographs as they were, with a note.
    pub fn refresh(&mut self, ctx: &Ctx, filter: Filter) {
        if !self.loaded() {
            self.first(ctx, filter);
            return;
        }
        let target = self.cells.len();
        let mut fresh = Self {
            page: ready(),
            ..Self::default()
        };
        let mut after: Option<wire::PhotosCursor> = None;
        loop {
            match Self::page(ctx, filter, after.as_ref()) {
                Reading::Data(page) => {
                    if after.is_none() {
                        fresh.total = page.total;
                    }
                    fresh.append(page);
                }
                // The photographs on screen are still true: they stay, with a note.
                other => {
                    self.unread(&other, ctx.locale());
                    return;
                }
            }
            after = fresh.next.clone();
            if after.is_none() || fresh.cells.len() >= target {
                break;
            }
        }
        *self = fresh;
    }
}

fn ready() -> Page<()> {
    Page::Ready {
        data: (),
        note: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kit::read::NoteKind;
    use crate::strings::shared;
    use wire::page_state::State;

    const EN: Locale = Locale::En;

    fn shown() -> Library {
        let mut library = Library::default();
        library.cells.push(wire::PhotosCell {
            photo_id: "a".to_owned(),
            ..wire::PhotosCell::default()
        });
        library.page = ready();
        library
    }

    fn wired(library: &Library) -> wire::PageState {
        library.drawn(EN).wire(
            EN,
            |denial| crate::photos::denied(EN, denial),
            wire::EmptyState::default,
        )
    }

    #[test]
    fn a_failed_first_read_is_the_failure_and_never_an_empty_grid() {
        let mut library = Library::default();
        library.unread(&Reading::Failed, EN);
        assert!(!library.loaded());
        assert!(matches!(wired(&library).state, Some(State::Failed(_))));
    }

    #[test]
    fn a_library_that_came_back_with_nothing_is_empty_and_never_ready() {
        let mut library = Library {
            page: ready(),
            ..Library::default()
        };
        assert!(matches!(wired(&library).state, Some(State::Empty(_))));
        // Photographs still to read are not nothing.
        library.next = Some(wire::PhotosCursor::default());
        assert!(wired(&library).state.is_none());
    }

    #[test]
    fn a_failed_refresh_over_an_empty_library_is_the_failure_and_never_empty() {
        let mut library = Library {
            page: ready(),
            ..Library::default()
        };
        library.unread(&Reading::Failed, EN);
        assert!(matches!(wired(&library).state, Some(State::Failed(_))));
    }

    #[test]
    fn a_denied_read_is_the_gate_with_its_receipt() {
        let mut library = Library::default();
        let denial = wire::AppQueryDenial {
            code: Some("no-read".to_owned()),
            ..wire::AppQueryDenial::default()
        };
        library.unread(&Reading::Denied(denial), EN);
        match wired(&library).state {
            Some(State::Refused(gate)) => assert_eq!(gate.receipt, "no-read"),
            other => panic!("expected the gate, found {other:?}"),
        }
    }

    #[test]
    fn a_next_page_that_did_not_come_keeps_the_photographs_under_a_partial_note() {
        let mut library = shown();
        library.more_failed = true;
        let page = wired(&library);
        assert!(page.state.is_none(), "ready draws the photographs");
        let note = page.note.expect("a note");
        assert_eq!(note.kind, wire::page_note::Kind::Partial as i32);
        assert_eq!(note.sentence, shared::read_more_failed(EN));
        assert_eq!(note.action_label, shared::kit_retry(EN));
        assert_eq!(library.cells.len(), 1);
    }

    #[test]
    fn a_failed_refresh_over_photographs_keeps_them_with_the_refresh_note() {
        let mut library = shown();
        library.unread(&Reading::Failed, EN);
        assert!(library.loaded());
        assert_eq!(library.cells.len(), 1);
        let note = library.page.note().expect("a note");
        assert_eq!(note.kind, NoteKind::Partial);
        assert_eq!(note.sentence, shared::read_refresh_failed(EN));
    }
}
