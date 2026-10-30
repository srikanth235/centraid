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
//! A second purpose, `Attach` (lane I): the same grid, ONE photograph, and Confirm hands the
//! pick to the chat screen (`chat.home`) as an `Attached` event instead of writing to an album.
//! Nothing is taken (no album), and choosing another photograph replaces the first.
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
    let attach = args.purpose == wire::PhotosPickerPurpose::Attach as i32;
    if args.album_id.is_empty() && !attach {
        return None;
    }
    Some(Box::new(Picker {
        attach,
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
    /// The purpose is to attach the pick to a chat question, not to fill an album.
    attach: bool,
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
        if !self.attach {
            self.read_members(ctx);
        }
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
        } else if self.attach {
            // One photograph: the member's last choice is the one they meant.
            self.picked = vec![id.to_owned()];
        } else {
            self.picked.push(id.to_owned());
        }
    }

    /// THE CHIP DRAWS THE PHOTOGRAPH, not a generic icon: the thumbnail path rides with the pick,
    /// from the same cell the grid drew it from (empty when no thumbnail is here, and the chip
    /// then falls back to its icon).
    fn thumbnail_of(&self, photo_id: &str) -> String {
        self.cells
            .iter()
            .find(|cell| cell.photo_id == photo_id)
            .and_then(|cell| cell.thumbnail_path.clone())
            .unwrap_or_default()
    }

    /// Hand the chosen photograph to the chat that asked for it, and finish.
    fn attach_pick(&mut self, ctx: &Ctx) {
        let Some(photo_id) = self.picked.first().cloned() else {
            return;
        };
        let thumbnail_path = self.thumbnail_of(&photo_id);
        ctx.post(crate::chat::HOME, attached(photo_id, thumbnail_path));
        self.finished = true;
    }

    fn confirm(&mut self, ctx: &Ctx) {
        if self.picked.is_empty() {
            return;
        }
        if self.attach {
            self.attach_pick(ctx);
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
            show_more_label: words::photos_show_all(locale),
            taken_label: words::photos_already_in_album(locale),
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
        let add_label = if self.attach {
            words::photos_attach(locale)
        } else if self.picked.is_empty() {
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
                    title: if self.attach {
                        words::photos_picker_attach_title(locale)
                    } else {
                        fill(
                            &words::photos_picker_title(locale),
                            &[("name", &self.album_name)],
                        )
                    },
                    chosen_label: self.chosen(locale),
                    add_label,
                    add_enabled: !self.picked.is_empty(),
                    refers_note: if self.attach {
                        String::new()
                    } else {
                        words::photos_album_refers(locale)
                    },
                    content: Some(content),
                    status: self.status.clone(),
                    finished: self.finished,
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}

/// The chat event that attaches one vault photograph, with the thumbnail its chip draws.
fn attached(photo_id: String, thumbnail_path: String) -> wire::ScreenEvent {
    wire::ScreenEvent {
        kind: Some(S::Chat(wire::ChatEvent {
            kind: Some(wire::chat_event::Kind::Attached(
                wire::chat_event::Attached {
                    source: Some(wire::chat_event::attached::Source::VaultPhoto(
                        wire::chat_event::VaultPhoto { asset_id: photo_id },
                    )),
                    label: String::new(),
                    thumbnail_path,
                },
            )),
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picker(cells: Vec<wire::PhotosCell>, picked: &str) -> Picker {
        Picker {
            attach: true,
            album_id: String::new(),
            album_name: String::new(),
            phase: Phase::Ready,
            cells,
            next: None,
            picked: vec![picked.to_owned()],
            taken: BTreeSet::new(),
            status: None,
            finished: false,
        }
    }

    fn cell(id: &str, thumbnail: Option<&str>) -> wire::PhotosCell {
        wire::PhotosCell {
            photo_id: id.to_owned(),
            thumbnail_path: thumbnail.map(str::to_owned),
            ..wire::PhotosCell::default()
        }
    }

    #[test]
    fn a_vault_pick_carries_the_thumbnail_its_cell_was_drawn_from() {
        let held = picker(
            vec![cell("p1", Some("/t/p1")), cell("p2", Some("/t/p2"))],
            "p2",
        );
        assert_eq!(held.thumbnail_of("p2"), "/t/p2");
        let Some(S::Chat(chat)) = attached("p2".to_owned(), held.thumbnail_of("p2")).kind else {
            panic!("not a chat event");
        };
        let Some(wire::chat_event::Kind::Attached(event)) = chat.kind else {
            panic!("not an attach");
        };
        assert_eq!(event.thumbnail_path, "/t/p2");
        assert!(matches!(
            event.source,
            Some(wire::chat_event::attached::Source::VaultPhoto(photo)) if photo.asset_id == "p2"
        ));
    }

    #[test]
    fn a_photo_with_no_thumbnail_attaches_with_an_empty_path() {
        let held = picker(vec![cell("p1", None)], "p1");
        assert_eq!(held.thumbnail_of("p1"), "");
        assert_eq!(held.thumbnail_of("gone"), "");
    }
}
