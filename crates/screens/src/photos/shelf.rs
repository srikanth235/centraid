//! `photos.shelf`: ONE SHELF OF THE LIBRARY UNDER A PREDICATE (#1029, #1135) —
//! favourites, videos, the archive, the trash, an album, a place, the photographs
//! with no place.
//!
//! One screen for what v0 drew as four, because they were four screens reading
//! one list in one order and drawing one cell, and they drifted exactly where
//! four copies drift. The predicate is the core's (`photos.shelf`'s `view`); what
//! is decided here is which verbs the shelf offers ([`Offer`]), this shelf's own
//! empty sentence, and what the member has picked.
//!
//! ## What a write does to the pick
//!
//! The selection ([`Selection`]) drains as photographs settle: those that
//! committed leave, those the vault refused stay picked and the vault's own
//! sentence lands in `status` (never in the read's `Failure`, so a refused delete
//! does not replace the shelf). A new shelf starts with nothing picked.
//!
//! ## Empty Trash is exactly what the trash shows
//!
//! The trash walks every page (it is the one shelf that must be whole to be
//! emptied). "Empty trash" is the shared verb (`empty-trash`, `entity.empty_trash`, kind photo,
//! one commit) when the trash is still exactly what the shelf showed; if something was trashed
//! since the member looked, it purges, one `purge-photo` each, the ids the shelf was showing and
//! no others, and the shelf then shows what is left.
//!
//! ## The trash is a grid, and the register knows it
//!
//! This shelf is Photos' Trash (#1185): thumbnails the member recognises, picked many at a time,
//! not the kit's list of rows. `cargo xtask rules` holds it to the same promise as every app's
//! trash (`crates/xtask/src/promises.rs`, `GRID_TRASH`): move to trash, restore, delete forever
//! and empty are manifest actions the screens call, in the kit's words.
//!
//! ## Dropped with the Kotlin architecture
//!
//! The seat, the page-read plumbing and cursors (`NextPageRequested`,
//! `DataArrived`, `ReadRefused`), the row-id filter on change events (a change
//! simply reloads), the `write_settled` event keyed by invoke-key text, and the
//! "list the trash, then purge" read (the shelf holds the list).

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_shelf_event::Kind as E;
use wire::screen_event::Kind as S;

use super::album_choice::{self, AlbumChoice};
use super::cells::{self, Link};
use super::keep_originals as keep;
use super::routes;
use super::selection::{Drain, Offer, Outcome, Selection, Verb, Wording, each};
use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::owner::{Answer as Owner, Leaving, NoPasscode, OwnerGate};
use crate::kit::read::{self, Note, Page, Reading};
use crate::kit::stale;
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, chat_confirm, fill, photos as words, photos_home as home_words,
    photos_shelf as shelf_words, shared as kit_words,
};

/// One page of a shelf (the core clamps to 200).
const PAGE: u32 = 200;
/// A shelf is never read past this many pages in one load.
const MAX_PAGES: usize = 200;
/// The trash's window, as the vault counts it (`entity.trash` stamps `purge_at`).
const PURGE_WINDOW_DAYS: u32 = 30;
/// A cell's lightbox walks this many neighbours either side of it.
const NEIGHBOURS: usize = 30;
/// Cursor halves are joined by U+001F in a load's `after`.
const CURSOR_SEPARATOR: char = '\u{1f}';

type Prompt = wire::photos_shelf_state::Prompt;
type Mode = wire::export_originals::Mode;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PhotosShelf(args)) = &route.args else {
        return None;
    };
    let kind = wire::PhotosShelfKind::try_from(args.kind).ok()?;
    if kind == wire::PhotosShelfKind::Unspecified {
        return None;
    }
    let offer = match kind {
        wire::PhotosShelfKind::Favorites => Offer::Favorites,
        wire::PhotosShelfKind::Archive => Offer::Archive,
        wire::PhotosShelfKind::Trash => Offer::Trash,
        wire::PhotosShelfKind::Album => Offer::Album(args.id.clone()),
        _ => Offer::Shelf,
    };
    let album = (kind == wire::PhotosShelfKind::Album).then_some(args.id.as_str());
    Some(Box::new(Shelf {
        kind,
        id: args.id.clone(),
        route_title: args.title.clone(),
        page: Page::loading(),
        more_failed: false,
        cells: Vec::new(),
        next: None,
        head: None,
        place: None,
        selection: Selection::new(offer, Drain::Settled, Wording::Chosen),
        choice: album.map_or_else(AlbumChoice::new, AlbumChoice::excluding),
        prompt: Prompt::Unspecified,
        notice: String::new(),
        keep: album.map(|_| Keep::default()),
        dismissed: false,
        copying: None,
        gate: OwnerGate::default(),
        sending: None,
        rename_rev: None,
    }))
}

/// The album's keep-originals switch, as the core's list last said it.
#[derive(Clone, Debug, Default)]
struct Keep {
    ready: bool,
    keep: bool,
    meta: String,
}

struct Shelf {
    /// The album's revision when the rename sheet opened: what a rename names as the one it
    /// replaces (#1185).
    rename_rev: Option<i64>,
    kind: wire::PhotosShelfKind,
    id: String,
    route_title: String,
    /// The read: the photographs below are its data. A shelf that holds nothing is drawn as
    /// [`Page::Empty`] by [`Shelf::drawn`], never as ready data.
    page: Page<()>,
    /// A next page was asked for and did not come: what loaded stays, with a note.
    more_failed: bool,
    /// The owner check a send asks first; no passcode warns and goes ahead.
    gate: OwnerGate,
    /// The send waiting on the check: whether the exact place travels.
    sending: Option<bool>,
    cells: Vec<wire::PhotosCell>,
    next: Option<wire::PhotosCursor>,
    head: Option<wire::PhotosAlbumHead>,
    place: Option<wire::PhotosPlaceCard>,
    selection: Selection,
    choice: AlbumChoice,
    prompt: Prompt,
    notice: String,
    keep: Option<Keep>,
    dismissed: bool,
    /// A hand-off is with the platform; a second is not started over it.
    copying: Option<Mode>,
}

fn view_of(kind: wire::PhotosShelfKind) -> load::photos::ShelfView {
    use load::photos::ShelfView as V;
    match kind {
        wire::PhotosShelfKind::Favorites => V::Favorites,
        wire::PhotosShelfKind::Videos => V::Videos,
        wire::PhotosShelfKind::Archive => V::Archive,
        wire::PhotosShelfKind::Trash => V::Trash,
        wire::PhotosShelfKind::Album => V::Album,
        wire::PhotosShelfKind::Place => V::Place,
        _ => V::Unplaced,
    }
}

impl Shelf {
    fn is_trash(&self) -> bool {
        self.kind == wire::PhotosShelfKind::Trash
    }

    fn is_album(&self) -> bool {
        self.kind == wire::PhotosShelfKind::Album
    }

    fn page(&self, ctx: &Ctx, after: Option<&wire::PhotosCursor>) -> Reading<wire::PhotosShelf> {
        read::read(
            ctx,
            load::photos::Shelf {
                limit: PAGE,
                view: view_of(self.kind),
                after: after
                    .map(|cursor| format!("{}{CURSOR_SEPARATOR}{}", cursor.sort_key, cursor.id)),
                id: matches!(
                    self.kind,
                    wire::PhotosShelfKind::Album | wire::PhotosShelfKind::Place
                )
                .then(|| self.id.clone()),
            },
            |answer| match answer {
                Answer::PhotosShelf(shelf) => Some(*shelf),
                _ => None,
            },
        )
    }

    /// A read that did not come: a gate shows the gate; a failure over photographs shown keeps
    /// them under a note, and over nothing shown is the failure itself.
    fn unread(&mut self, reading: Reading<wire::PhotosShelf>, locale: Locale) {
        let mut held = std::mem::replace(&mut self.page, Page::loading());
        if held.data().is_some() && self.holds_nothing() {
            held = Page::Empty;
        }
        self.page = match reading {
            Reading::Denied(denial) => Page::Refused(denial),
            _ => held.after(Reading::Failed, locale, |()| false),
        };
        if self.page.data().is_none() {
            self.cells.clear();
            self.next = None;
        }
    }

    /// Read the shelf again: at least as many photographs as were on screen, and
    /// the whole trash.
    fn reload(&mut self, ctx: &Ctx) {
        let want = self.cells.len().max(PAGE as usize);
        let whole = self.is_trash();
        let first = match self.page(ctx, None) {
            Reading::Data(first) => first,
            other => return self.unread(other, ctx.locale()),
        };
        self.head = first.album.clone();
        self.place = first.place.clone();
        let mut cells = first.cells;
        let mut next = first.next;
        let mut pages = 1;
        while let Some(cursor) = next.clone() {
            if !(whole || cells.len() < want) || pages >= MAX_PAGES {
                break;
            }
            let more = match self.page(ctx, Some(&cursor)) {
                Reading::Data(more) => more,
                other => return self.unread(other, ctx.locale()),
            };
            cells.extend(more.cells);
            next = more.next;
            pages += 1;
        }
        self.cells = cells;
        self.next = next;
        self.page = Page::Ready {
            data: (),
            note: None,
        };
        self.more_failed = false;
        // An album that is not there (purged, or never was) has nothing to show.
        if self.is_album() && self.head.is_none() {
            self.dismissed = true;
        }
        self.load_keep(ctx);
    }

    fn load_more(&mut self, ctx: &Ctx) {
        let Some(cursor) = self.next.clone() else {
            return;
        };
        let more = match self.page(ctx, Some(&cursor)) {
            Reading::Data(more) => more,
            Reading::Failed => {
                self.more_failed = true;
                return;
            }
            other => return self.unread(other, ctx.locale()),
        };
        self.more_failed = false;
        let known: Vec<String> = self.cells.iter().map(|c| c.photo_id.clone()).collect();
        self.cells.extend(
            more.cells
                .into_iter()
                .filter(|cell| !known.contains(&cell.photo_id)),
        );
        self.next = more.next;
    }

    /// The row the keep list's answer makes for this album.
    fn keep_row(
        &self,
        locale: Locale,
        answer: centraid_core::Result<wire::OriginalsResponse>,
    ) -> Keep {
        match answer {
            Ok(kept) => {
                let keep = kept.kept_album_ids.contains(&self.id);
                Keep {
                    ready: true,
                    keep,
                    meta: keep::meta(locale, keep),
                }
            }
            Err(_) => Keep {
                ready: false,
                keep: false,
                meta: keep::SwitchRow::unreadable(locale),
            },
        }
    }

    /// The keep list's word for this album.
    fn load_keep(&mut self, ctx: &Ctx) {
        if self.keep.is_none() {
            return;
        }
        let answer = ctx.originals(&wire::OriginalsRequest {
            op: Some(wire::originals_request::Op::Kept(wire::KeptAlbumsRead {})),
        });
        self.keep = Some(self.keep_row(ctx.locale(), answer));
    }

    fn toggle_keep(&mut self, keep_it: bool, ctx: &Ctx) {
        if !self
            .keep
            .as_ref()
            .is_some_and(|row| row.ready && row.keep != keep_it)
        {
            return;
        }
        let answer = ctx.originals(&wire::OriginalsRequest {
            op: Some(wire::originals_request::Op::Keep(
                wire::KeepAlbumOriginals {
                    album_id: self.id.clone(),
                    keep: keep_it,
                },
            )),
        });
        self.keep = Some(self.keep_row(ctx.locale(), answer));
    }

    fn ordered(&self) -> Vec<String> {
        cells::dedupe_live(&self.cells)
            .into_iter()
            .map(|cell| cell.photo_id.clone())
            .collect()
    }

    fn selection_event(&mut self, event: &wire::PhotosSelectionEvent, ctx: &Ctx) {
        self.notice.clear();
        let ordered = self.ordered();
        match self.selection.update(event, &ordered, ctx) {
            Outcome::Moved => {}
            Outcome::OpenAlbumChoice => {
                let opened = wire::PhotosAlbumChoiceEvent {
                    kind: Some(wire::photos_album_choice_event::Kind::Opened(
                        wire::photos_album_choice_event::Opened {},
                    )),
                };
                let picked = self.selection.picked().to_vec();
                self.choice
                    .update(&opened, &picked, self.selection.door(), ctx);
            }
            Outcome::Wrote(_) => self.reload(ctx),
        }
    }

    fn album_choice_event(&mut self, event: &wire::PhotosAlbumChoiceEvent, ctx: &Ctx) {
        self.notice.clear();
        let picked = self.selection.picked().to_vec();
        match self
            .choice
            .update(event, &picked, self.selection.door(), ctx)
        {
            album_choice::Outcome::Moved => {}
            album_choice::Outcome::Added { written, .. } => {
                self.selection.settle(&written, Verb::AddToAlbum);
                self.reload(ctx);
            }
            album_choice::Outcome::Created { refusal } => self.selection.refuse(refusal),
        }
    }

    /// Open a sheet. Each is offered only where it means something.
    fn open_prompt(&mut self, prompt: Prompt) {
        let allowed = match prompt {
            Prompt::Unspecified => false,
            Prompt::EmptyTrash => self.is_trash() && !self.cells.is_empty(),
            Prompt::DeleteAlbum | Prompt::RenameAlbum => self.is_album() && !self.head_trashed(),
            Prompt::SendLocation => !self.selection.picked().is_empty(),
        };
        if allowed {
            self.prompt = prompt;
            self.notice.clear();
        }
    }

    fn head_trashed(&self) -> bool {
        self.head
            .as_ref()
            .is_some_and(|head| head.deleted_at.is_some())
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        let prompt = std::mem::replace(&mut self.prompt, Prompt::Unspecified);
        match prompt {
            Prompt::EmptyTrash if self.is_trash() => self.empty_trash(ctx),
            Prompt::DeleteAlbum if self.is_album() => self.delete_album(ctx),
            _ => {}
        }
    }

    /// EMPTY TRASH is exactly what the member saw. The trash is read once more: if it is still
    /// the ids the shelf showed, the shared `empty-trash` verb empties it in one commit; if
    /// something was trashed since, only the ids the shelf showed are purged, one `purge-photo`
    /// each, never a fresh list of the whole trash.
    fn empty_trash(&mut self, ctx: &Ctx) {
        let seen: Vec<String> = self
            .cells
            .iter()
            .map(|cell| cell.photo_id.clone())
            .collect();
        self.reload(ctx);
        let unchanged = self.cells.len() == seen.len()
            && self.cells.iter().all(|cell| seen.contains(&cell.photo_id));
        if unchanged {
            let key = kit_act::key(&["empty-trash", "photo"], kit_act::fresh());
            self.selection.refuse(None);
            // Emptying the trash cannot be taken back, and asked first: it says nothing.
            self.selection.door().act_quietly(
                ctx,
                act::photos::EmptyTrash {
                    kind: Some(act::photos::EmptyTrashKind::Photo),
                    ..Default::default()
                },
                &key,
            );
        } else {
            let written = each(
                ctx,
                self.selection.door(),
                &seen,
                "purge-photo",
                None,
                |id| {
                    act::photos::PurgePhoto {
                        photo_id: id.to_owned(),
                    }
                    .into()
                },
            );
            self.selection.refuse(written.refusal);
        }
        self.reload(ctx);
    }

    fn delete_album(&mut self, ctx: &Ctx) {
        let key = kit_act::key(&["delete-album", &self.id], kit_act::fresh());
        self.selection.refuse(None);
        let settled = self.selection.door().act(
            ctx,
            act::photos::DeleteAlbum {
                album_id: self.id.clone(),
            },
            &key,
            shelf_words::album_deleted,
        );
        if settled.committed {
            // THE PAGE CLOSES: "Album deleted" and its Undo go to the page beneath (#1185).
            self.selection.door().hand_down(ctx);
            self.dismissed = true;
        }
    }

    fn rename_album(&mut self, title: &str, ctx: &Ctx) {
        self.prompt = Prompt::Unspecified;
        let name = title.trim();
        let current = self.head.as_ref().map(|head| head.title.as_str());
        // An empty name is refused by the vault and the same name changes
        // nothing: neither is a round trip worth waiting through.
        if !self.is_album() || name.is_empty() || current == Some(name) {
            return;
        }
        let key = kit_act::key(&["rename-album", &self.id, name], kit_act::fresh());
        self.selection.refuse(None);
        let settled = self.selection.door().act(
            ctx,
            act::photos::RenameAlbum {
                album_id: self.id.clone(),
                title: name.to_owned(),
                expected_rev: self.rename_rev,
            },
            &key,
            shelf_words::album_renamed,
        );
        // The album changed, or went to the trash, since the sheet opened: the name typed is
        // kept as an earlier version and the page reads the album as it is now (#1185).
        let said = settled.stale().map(|stale| {
            stale::on_button(
                ctx,
                &chat_confirm::noun_album(ctx.locale()),
                &self.id,
                stale,
                vec![("entity.title".to_owned(), name.into())],
            )
        });
        self.reload(ctx);
        if let Some(said) = said {
            self.selection.door().refuse(said);
        }
    }

    /// "Make key photo": the vault refuses a cover that is not a member, so it
    /// is offered over exactly one pick.
    fn choose_cover(&mut self, ctx: &Ctx) {
        let [photo] = self.selection.picked() else {
            return;
        };
        if !self.is_album() {
            return;
        }
        let photo = photo.clone();
        let key = kit_act::key(&["set-album-cover", &self.id, &photo], kit_act::fresh());
        self.selection.refuse(None);
        self.selection.door().act(
            ctx,
            act::photos::SetAlbumCover {
                album_id: self.id.clone(),
                photo_id: Field::Is(photo),
            },
            &key,
            shelf_words::cover_changed,
        );
        self.reload(ctx);
    }

    /// Bring a trashed album back, with its ordered photographs.
    fn restore_album(&mut self, ctx: &Ctx) {
        if !self.is_album() || !self.head_trashed() {
            return;
        }
        let key = kit_act::key(&["restore-album", &self.id], kit_act::fresh());
        self.selection.refuse(None);
        self.selection.door().act(
            ctx,
            act::photos::RestoreAlbum {
                album_id: self.id.clone(),
            },
            &key,
            shelf_words::album_restored,
        );
        self.reload(ctx);
    }

    /// Hand the pick's originals to the platform: its share sheet or this
    /// device's photos. SENDING ASKS THE OWNER CHECK FIRST (the bytes leave the
    /// phone); saving to this device's photos does not. The shell finds the
    /// files and takes the place out.
    fn copy(&mut self, mode: Mode, keep_location: bool, ctx: &Ctx) -> Vec<wire::Effect> {
        self.prompt = Prompt::Unspecified;
        self.notice.clear();
        if self.selection.picked().is_empty() || self.copying.is_some() || self.gate.asking() {
            return Vec::new();
        }
        if mode == Mode::Send {
            self.sending = Some(keep_location);
            return self.gate.begin(ctx.locale(), Leaving::Share);
        }
        self.hand_over(mode, keep_location, ctx.locale())
    }

    fn hand_over(&mut self, mode: Mode, keep_location: bool, locale: Locale) -> Vec<wire::Effect> {
        let ids = self.selection.picked().to_vec();
        if ids.is_empty() {
            return Vec::new();
        }
        self.copying = Some(mode);
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::ExportOriginals(
                super::export_originals(locale, ids, mode, keep_location),
            )),
        }]
    }

    /// The owner check's answer for a send.
    fn checked(&mut self, checked: &wire::OwnerChecked, locale: Locale) -> Vec<wire::Effect> {
        let keep_location = self.sending.take().unwrap_or(false);
        match self.gate.answer(locale, NoPasscode::Warn, checked) {
            Some(Owner::Passed) => self.hand_over(Mode::Send, keep_location, locale),
            Some(Owner::PassedUnprotected(warning)) => {
                let effects = self.hand_over(Mode::Send, keep_location, locale);
                self.notice = warning;
                effects
            }
            Some(Owner::Refused(sentence)) => {
                self.notice = sentence;
                Vec::new()
            }
            Some(Owner::Cancelled) | None => Vec::new(),
        }
    }

    fn copied(&mut self, result: &wire::EffectResult, locale: Locale) {
        let mode = self.copying.take();
        self.notice = match &result.outcome {
            Some(wire::effect_result::Outcome::OriginalsExported(done)) => {
                export_sentence(locale, mode, done)
            }
            _ => home_words::copy_export_failed(locale),
        };
    }

    fn event(&mut self, event: wire::PhotosShelfEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::LoadMore(_)) => self.load_more(ctx),
            Some(E::Refreshed(_)) => self.reload(ctx),
            Some(E::Selection(selection)) => self.selection_event(&selection, ctx),
            Some(E::AlbumChoice(choice)) => self.album_choice_event(&choice, ctx),
            Some(E::PromptOpened(opened)) => {
                self.open_prompt(Prompt::try_from(opened.prompt).unwrap_or(Prompt::Unspecified));
                if self.prompt == Prompt::RenameAlbum {
                    self.rename_rev = stale::read_rev(ctx, &self.id);
                }
            }
            Some(E::PromptDismissed(_)) => self.prompt = Prompt::Unspecified,
            Some(E::PromptConfirmed(_)) => self.confirmed(ctx),
            Some(E::LocationChosen(chosen)) => return self.copy(Mode::Send, chosen.exact, ctx),
            Some(E::AlbumRenamed(renamed)) => self.rename_album(&renamed.title, ctx),
            Some(E::CoverChosen(_)) => self.choose_cover(ctx),
            Some(E::KeepToggled(toggled)) => self.toggle_keep(toggled.keep, ctx),
            Some(E::AlbumRestored(_)) => self.restore_album(ctx),
            Some(E::Download(_)) => return self.copy(Mode::Save, true, ctx),
            None => {}
        }
        Vec::new()
    }

    // -- the view --------------------------------------------------------------

    fn title(&self, locale: Locale) -> String {
        match self.kind {
            wire::PhotosShelfKind::Album => self
                .head
                .as_ref()
                .map_or_else(|| self.route_title.clone(), |head| head.title.clone()),
            wire::PhotosShelfKind::Place => self.place.as_ref().map_or_else(
                || self.route_title.clone(),
                |card| {
                    if card.phrase.is_empty() {
                        words::place_unnamed(locale)
                    } else {
                        card.phrase.clone()
                    }
                },
            ),
            wire::PhotosShelfKind::Unplaced => words::place_no_location(locale),
            wire::PhotosShelfKind::Favorites => words::photos_filter_favorites(locale),
            wire::PhotosShelfKind::Archive => words::photos_archive(locale),
            wire::PhotosShelfKind::Trash => words::photos_trash(locale),
            wire::PhotosShelfKind::Videos => shelf_words::title_videos(locale),
            wire::PhotosShelfKind::Unspecified => words::photos_shelf_title(locale),
        }
    }

    /// No photograph to show: what the shelf read came to nothing live.
    fn holds_nothing(&self) -> bool {
        cells::dedupe_live(&self.cells).is_empty()
    }

    /// The page as drawn: ready means there is something to show, so a shelf that holds nothing
    /// is [`Page::Empty`]; a next page that did not come adds its note over the photographs.
    fn drawn(&self, locale: Locale) -> Page<()> {
        if self.page.data().is_some() && self.holds_nothing() {
            return Page::Empty;
        }
        self.page
            .clone()
            .noted(self.more_failed.then(|| Note::more_failed(locale)))
    }

    /// NOTHING HERE, AND WHY: one sentence per shelf.
    fn empty(&self, locale: Locale) -> wire::EmptyState {
        let headline = match self.kind {
            wire::PhotosShelfKind::Album => shelf_words::empty_album(locale),
            wire::PhotosShelfKind::Unplaced => shelf_words::empty_every_photo_placed(locale),
            wire::PhotosShelfKind::Place => fill(
                &shelf_words::empty_place(locale),
                &[("name", &self.title(locale))],
            ),
            wire::PhotosShelfKind::Favorites => words::photos_empty_favorites(locale),
            wire::PhotosShelfKind::Archive => words::photos_archive_empty(locale),
            wire::PhotosShelfKind::Trash => shelf_words::empty_trash(locale),
            wire::PhotosShelfKind::Videos => shelf_words::empty_videos(locale),
            wire::PhotosShelfKind::Unspecified => words::photos_shelf_nothing(locale),
        };
        wire::EmptyState {
            headline,
            body: if self.is_album() {
                words::photos_album_refers(locale)
            } else {
                String::new()
            },
            ..wire::EmptyState::default()
        }
    }

    fn data(&self, locale: Locale) -> wire::PhotosShelfData {
        let shown = cells::dedupe_live(&self.cells);
        let album_id = if self.is_album() {
            self.id.as_str()
        } else {
            ""
        };
        let ids: Vec<String> = shown.iter().map(|cell| cell.photo_id.clone()).collect();
        let tiles: Vec<wire::PhotosShelfCell> = shown
            .iter()
            .enumerate()
            .map(|(at, cell)| {
                let low = at.saturating_sub(NEIGHBOURS);
                let high = (at + NEIGHBOURS + 1).min(ids.len());
                wire::PhotosShelfCell {
                    tile: Some(cells::tile(cell, Link::default(), locale)),
                    open: Some(routes::lightbox(&cell.photo_id, &ids[low..high], album_id)),
                }
            })
            .collect();
        let capped = self.next.is_some();
        let count = u32::try_from(tiles.len()).unwrap_or(u32::MAX);
        wire::PhotosShelfData {
            count_label: cells::count_phrase(locale, count, capped),
            can_show_more: capped,
            show_more_label: words::photos_show_all(locale),
            empty_trash_label: (self.is_trash() && !tiles.is_empty())
                .then(|| kit_words::trash_empty_action(locale)),
            cells: tiles,
        }
    }

    fn album(&self, locale: Locale) -> Option<wire::PhotosShelfAlbum> {
        if !self.is_album() {
            return None;
        }
        let name = self.title(locale);
        let trashed = self.head_trashed();
        Some(wire::PhotosShelfAlbum {
            album_id: self.id.clone(),
            add_route: Some(routes::picker(&self.id, &name)),
            name,
            trashed,
            trashed_note: if trashed {
                shelf_words::album_in_trash(locale)
            } else {
                String::new()
            },
            restore_label: shelf_words::album_restore(locale),
            add_label: words::photos_add_photos(locale),
            options_label: words::photos_album_options(locale),
            rename_label: words::photos_rename_album(locale),
            delete_label: words::photos_delete_album(locale),
        })
    }

    /// The confirm over `empty trash` or `delete album`, in the screen's words.
    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        match self.prompt {
            Prompt::EmptyTrash => Some(wire::Confirm {
                title: kit_words::trash_empty_title(locale),
                body: kit_words::trash_empty_body(locale),
                confirm_label: kit_words::trash_empty_action(locale),
                destructive: true,
            }),
            Prompt::DeleteAlbum => Some(wire::Confirm {
                title: words::photos_delete_album_title(locale),
                body: words::photos_delete_album_body(locale),
                confirm_label: words::photos_delete_album(locale),
                destructive: true,
            }),
            _ => None,
        }
    }

    fn bar(&self, locale: Locale) -> wire::PhotosShelfBar {
        let picked = self.selection.picked().len();
        wire::PhotosShelfBar {
            send_copy_label: words::photos_send_copy(locale),
            download_label: words::photos_download_original(locale),
            make_key_label: words::photos_make_key(locale),
            make_key_offered: self.is_album(),
            make_key_enabled: self.is_album() && picked == 1,
            more_label: words::photos_more(locale),
            enabled: picked > 0,
        }
    }
}

/// What a hand-off came to, in one clause: the sheet says what it did, so a send
/// that went says only what did not.
fn export_sentence(locale: Locale, mode: Option<Mode>, done: &wire::OriginalsExported) -> String {
    use wire::originals_exported::Status;
    let missing = match done.missing {
        0 => String::new(),
        1 => home_words::copy_missing_one(locale),
        n => fill(
            &home_words::copy_missing_many(locale),
            &[("count", &n.to_string())],
        ),
    };
    match Status::try_from(done.status).unwrap_or(Status::Unspecified) {
        Status::NoneHere => home_words::copy_none_here(locale),
        Status::LocationNotRemovable => home_words::copy_location_not_removable(locale),
        Status::Failed | Status::Unspecified => home_words::copy_export_failed(locale),
        Status::Done if mode == Some(Mode::Save) => {
            let saved = match done.handed {
                0 => String::new(),
                1 => words::photos_export_saved(locale),
                n => fill(
                    &home_words::copy_saved_many(locale),
                    &[("count", &n.to_string())],
                ),
            };
            [saved, missing]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        }
        Status::Done => missing,
    }
}

impl Screen for Shelf {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(S::Appeared(_) | S::EnvironmentChanged(_)) => self.reload(ctx),
            Some(S::DataChanged(_)) => {
                self.reload(ctx);
                self.choice.reload(ctx);
                // THE PICKER ABOVE CLOSED: its line and Undo are drawn here.
                self.selection.door().take_handed(ctx);
            }
            Some(S::PhotosShelf(shelf)) => return self.event(shelf, ctx),
            Some(S::EffectResult(result)) => {
                use wire::effect_result::Outcome as O;
                if self.gate.asking() {
                    let checked = match &result.outcome {
                        Some(O::OwnerChecked(checked)) => Some(*checked),
                        // The prompt itself errored: the same as not recognised.
                        Some(O::Failed(_)) => Some(wire::OwnerChecked {
                            outcome: wire::owner_checked::Outcome::Failed as i32,
                            ..Default::default()
                        }),
                        _ => None,
                    };
                    if let Some(checked) = checked {
                        return self.checked(&checked, ctx.locale());
                    }
                }
                self.copied(&result, ctx.locale());
            }
            Some(S::StatusActed(_)) => {
                if self.selection.acted(ctx) {
                    self.reload(ctx);
                }
            }
            Some(S::Left(_)) => {
                self.selection.door().clear();
                return self.gate.cancel();
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let page = self.drawn(locale);
        let prompt = self.prompt;
        let state = wire::PhotosShelfState {
            title: self.title(locale),
            kind: self.kind as i32,
            page: Some(page.wire(
                locale,
                |denial| super::denied(locale, denial),
                || self.empty(locale),
            )),
            content: page
                .data()
                .map(|()| wire::photos_shelf_state::Content::Data(Box::new(self.data(locale)))),
            selection: Some(self.selection.view(locale)),
            status: self.selection.status(locale),
            notice: self.notice.clone(),
            purge_window: if self.is_trash() {
                fill(
                    &shelf_words::purge_window(locale),
                    &[("days", &PURGE_WINDOW_DAYS.to_string())],
                )
            } else {
                String::new()
            },
            album_choice: Some(self.choice.view(locale, Link::default())),
            album: self.album(locale),
            prompt: prompt as i32,
            confirm: self.confirm(locale),
            location_choice: (prompt == Prompt::SendLocation).then(|| wire::PhotosLocationChoice {
                title: words::photos_send_place_title(locale),
                none_label: words::photos_send_no_location(locale),
                exact_label: words::photos_send_exact_location(locale),
                cancel_label: words::photos_cancel(locale),
            }),
            rename: (prompt == Prompt::RenameAlbum).then(|| wire::PhotosRenameSheet {
                title: words::photos_rename_album(locale),
                field_label: words::photos_album_name(locale),
                current: self.title(locale),
                save_label: words::photos_save(locale),
                cancel_label: words::photos_cancel(locale),
            }),
            keep_originals: self.keep.as_ref().map(|row| wire::PhotosKeepSwitch {
                title: keep::switch_title(locale),
                label: keep::switch_label(locale),
                ready: row.ready,
                keep: row.keep,
                meta: if row.meta.is_empty() {
                    home_words::keep_checking(locale)
                } else {
                    row.meta.clone()
                },
            }),
            dismissed: self.dismissed,
            chrome: Some(wire::PhotosShelfChrome {
                select_label: words::photos_select(locale),
                done_label: words::photos_done(locale),
            }),
            bar: Some(self.bar(locale)),
            prompt_cancel_label: if self.is_album() {
                words::photos_keep_it(locale)
            } else {
                words::photos_keep_them(locale)
            },
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PhotosShelf(Box::new(state))),
            ..wire::ViewState::default()
        }
    }
}
