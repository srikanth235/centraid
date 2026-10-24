//! THE LIBRARY'S READ: the live photographs (or the favourites) a page at a time,
//! newest first and then the undated tail, which the core's shelf walks as one
//! cursor. A page is read when the end of what is loaded comes into view; a write
//! or a change READS AGAIN IN PLACE: the pages the member had scrolled through are
//! read again into a buffer and swapped in whole, so a favourite neither blanks
//! the grid nor throws the scroll back to the top.
//!
//! A refused FIRST read replaces the library with its sentence (a failed read is
//! not an empty grid). A refused next page or refresh leaves the library EXACTLY
//! as it is: the photographs on screen are still true.

use centraid_api_proto::core_v1 as wire;
use wire::PhotosFilter as Filter;
use wire::app_query_response::Answer;

use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;

/// A mosaic's page: bigger than a list's, still well under the door's clamp.
pub const PAGE: u32 = 120;

#[derive(Clone, Debug, Default)]
pub enum Phase {
    #[default]
    Loading,
    Failed,
    Ready,
}

#[derive(Debug, Default)]
pub struct Library {
    pub phase: Phase,
    /// Every cell read so far, in the shelf's order, none twice.
    pub cells: Vec<wire::PhotosCell>,
    next: Option<wire::PhotosCursor>,
    /// The shelf's exact size, from the first page.
    pub total: Option<u32>,
    /// A next page was asked for and refused: the library stays, the end is not
    /// known.
    pub more_failed: bool,
}

impl Library {
    /// Both walks have ended: every photograph is in `cells`.
    #[must_use]
    pub fn complete(&self) -> bool {
        matches!(self.phase, Phase::Ready) && self.next.is_none() && !self.more_failed
    }

    #[must_use]
    pub fn loaded(&self) -> bool {
        matches!(self.phase, Phase::Ready)
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
                self.phase = Phase::Ready;
            }
            Reading::Denied(_) | Reading::Failed => self.phase = Phase::Failed,
        }
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
            _ => self.more_failed = true,
        }
    }

    /// READ AGAIN IN PLACE: as many pages as the member had scrolled through,
    /// swapped in whole. A refusal leaves the library as it was.
    pub fn refresh(&mut self, ctx: &Ctx, filter: Filter) {
        if !self.loaded() {
            self.first(ctx, filter);
            return;
        }
        let target = self.cells.len();
        let mut fresh = Self {
            phase: Phase::Ready,
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
                _ => return,
            }
            after = fresh.next.clone();
            if after.is_none() || fresh.cells.len() >= target {
                break;
            }
        }
        *self = fresh;
    }
}
