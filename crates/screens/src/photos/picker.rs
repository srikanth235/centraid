//! `photos.picker`: CHOOSING PHOTOGRAPHS FOR AN ALBUM (#1029, #1135).
//!
//! The library as a grid, with what the album already holds drawn as taken: a
//! member hunting for the photograph they added last week finds it and finds out
//! why it will not tick. The rule is Rust's, not the drawing's: a taken cell
//! cannot be picked, so no add is ever sent for a row the album has.
//!
//! Confirm is one `add-to-album` per pick, the same writes as the shelf's "Add to
//! album" sheet ([`album_choice::add`]), so a photograph already in the album is
//! a no-op and a refused one carries the vault's own sentence. Picks that
//! committed leave the set; the ones the vault refused stay picked, and the
//! sentence lands in `status`, never in the read's `Failure`, so the grid is not
//! replaced mid-pick. When every pick landed the screen is `finished` and the
//! shell pops.
//!
//! Dropped with the Kotlin architecture: the seat, the page-read plumbing and
//! its cursor events, the members read as a second "pass" (the album's own shelf
//! is read here), the row-id filter on change events, and the settle event keyed
//! by invoke-key text.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_picker_event::Kind as E;
use wire::screen_event::Kind as S;

use super::album_choice;
use super::cells::{self, Link};
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, photos as words};

const PAGE: u32 = 200;
const MAX_PAGES: usize = 200;
const CURSOR_SEPARATOR: char = '\u{1f}';

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PhotosPicker(args)) = &route.args else {
        return None;
    };
    if args.album_id.is_empty() {
        return None;
    }
    Some(Box::new(Picker {
        album_id: args.album_id.clone(),
        album_name: args.album_name.clone(),
        phase: Phase::Loading,
        cells: Vec::new(),
        next: None,
        taken: BTreeSet::new(),
        picked: Vec::new(),
        status: None,
        finished: false,
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Loading,
    Failed,
    Ready,
}

struct Picker {
    album_id: String,
    album_name: String,
    phase: Phase,
    cells: Vec<wire::PhotosCell>,
    next: Option<wire::PhotosCursor>,
    taken: BTreeSet<String>,
    picked: Vec<String>,
    status: Option<wire::StatusLine>,
    finished: bool,
}

fn page(
    ctx: &Ctx,
    view: load::photos::ShelfView,
    id: Option<&str>,
    after: Option<&wire::PhotosCursor>,
) -> Reading<wire::PhotosShelf> {
    read::read(
        ctx,
        load::photos::Shelf {
            limit: PAGE,
            view,
            after: after
                .map(|cursor| format!("{}{CURSOR_SEPARATOR}{}", cursor.sort_key, cursor.id)),
            id: id.map(str::to_owned),
        },
        |answer| match answer {
            Answer::PhotosShelf(shelf) => Some(*shelf),
            _ => None,
        },
    )
}

impl Picker {
    fn reload(&mut self, ctx: &Ctx) {
        let want = self.cells.len().max(PAGE as usize);
        let Reading::Data(first) = page(ctx, load::photos::ShelfView::Live, None, None) else {
            self.phase = Phase::Failed;
            self.cells.clear();
            return;
        };
        let mut cells = first.cells;
        let mut next = first.next;
        let mut pages = 1;
        while let Some(cursor) = next.clone() {
            if cells.len() >= want || pages >= MAX_PAGES {
                break;
            }
            let Reading::Data(more) = page(ctx, load::photos::ShelfView::Live, None, Some(&cursor))
            else {
                self.phase = Phase::Failed;
                self.cells.clear();
                return;
            };
            cells.extend(more.cells);
            next = more.next;
            pages += 1;
        }
        self.cells = cells;
        self.next = next;
        self.phase = Phase::Ready;
        self.read_members(ctx);
    }

    /// What the album holds, walked to the end: a floor would let a member add
    /// one twice and discover it afterwards.
    fn read_members(&mut self, ctx: &Ctx) {
        let mut taken = BTreeSet::new();
        let mut after: Option<wire::PhotosCursor> = None;
        for _ in 0..MAX_PAGES {
            let Reading::Data(members) = page(
                ctx,
                load::photos::ShelfView::Album,
                Some(&self.album_id),
                after.as_ref(),
            ) else {
                // Unreadable members leave what was known: the vault's own
                // idempotent add is the backstop.
                return;
            };
            taken.extend(members.cells.into_iter().map(|cell| cell.photo_id));
            match members.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        self.taken = taken;
        self.picked.retain(|id| !self.taken.contains(id));
    }

    fn load_more(&mut self, ctx: &Ctx) {
        let Some(cursor) = self.next.clone() else {
            return;
        };
        let Reading::Data(more) = page(ctx, load::photos::ShelfView::Live, None, Some(&cursor))
        else {
            self.phase = Phase::Failed;
            self.cells.clear();
            return;
        };
        let known: BTreeSet<String> = self.cells.iter().map(|c| c.photo_id.clone()).collect();
        self.cells.extend(
            more.cells
                .into_iter()
                .filter(|c| !known.contains(&c.photo_id)),
        );
        self.next = more.next;
    }

    fn pick(&mut self, id: &str) {
        if self.taken.contains(id) || !self.cells.iter().any(|cell| cell.photo_id == id) {
            return;
        }
        if let Some(at) = self.picked.iter().position(|picked| picked == id) {
            self.picked.remove(at);
        } else {
            self.picked.push(id.to_owned());
        }
    }

    fn confirm(&mut self, ctx: &Ctx) {
        if self.picked.is_empty() {
            return;
        }
        self.status = None;
        let written = album_choice::add(ctx, &self.picked, &self.album_id);
        for id in &written.committed {
            self.taken.insert(id.clone());
        }
        self.picked.retain(|id| !written.committed.contains(id));
        match written.refusal {
            Some(sentence) => {
                self.status = Some(wire::StatusLine {
                    sentence,
                    action_label: String::new(),
                    refused: true,
                });
            }
            None => self.finished = true,
        }
    }

    fn chosen(&self, locale: Locale) -> String {
        if self.picked.is_empty() {
            words::photos_picker_nothing_chosen(locale)
        } else {
            fill(
                &words::photos_chosen(locale),
                &[("count", &self.picked.len().to_string())],
            )
        }
    }

    fn data(&self, locale: Locale) -> wire::PhotosPickerData {
        let cells: Vec<wire::PhotosPickerCell> = cells::dedupe_live(&self.cells)
            .into_iter()
            .map(|cell| wire::PhotosPickerCell {
                tile: Some(cells::tile(cell, Link::default(), locale)),
                taken: self.taken.contains(&cell.photo_id),
                picked: self.picked.contains(&cell.photo_id),
            })
            .collect();
        // Nothing left to add: every photograph shown is the album's already, and
        // there is no more to read.
        let nothing_left = self.next.is_none() && cells.iter().all(|cell| cell.taken);
        wire::PhotosPickerData {
            can_show_more: self.next.is_some(),
            empty: nothing_left.then(|| wire::EmptyState {
                headline: words::photos_picker_nothing_left(locale),
                ..wire::EmptyState::default()
            }),
            cells,
        }
    }
}

impl Screen for Picker {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(S::Appeared(_) | S::DataChanged(_) | S::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(S::PhotosPicker(picker)) => match picker.kind {
                Some(E::LoadMore(_)) => self.load_more(ctx),
                Some(E::Pick(pick)) => self.pick(&pick.photo_id),
                Some(E::Confirm(_)) => self.confirm(ctx),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match self.phase {
            Phase::Loading => {
                wire::photos_picker_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::photos_picker_state::Content::Failure(read::failure(locale)),
            Phase::Ready => wire::photos_picker_state::Content::Data(Box::new(self.data(locale))),
        };
        let add_label = if self.picked.is_empty() {
            words::photos_add(locale)
        } else {
            fill(
                &words::photos_add_count(locale),
                &[("count", &self.picked.len().to_string())],
            )
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PhotosPicker(Box::new(
                wire::PhotosPickerState {
                    title: fill(
                        &words::photos_picker_title(locale),
                        &[("name", &self.album_name)],
                    ),
                    chosen_label: self.chosen(locale),
                    add_label,
                    add_enabled: !self.picked.is_empty(),
                    refers_note: words::photos_album_refers(locale),
                    content: Some(content),
                    status: self.status.clone(),
                    finished: self.finished,
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}
