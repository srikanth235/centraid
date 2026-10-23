//! SELECT MODE, ONCE, FOR EVERY PHOTOS SCREEN THAT HAS ONE (#1135): the library
//! grid and each shelf hold a [`Selection`] and hand it their events. It owns the
//! mode, the picked set (in the order picked), the bar's sentence and verbs, the
//! confirm over the destructive ones, the batch writes and the refusal line.
//!
//! ## One write per photograph
//!
//! The vault registers each verb over a single photograph, so a batch is one
//! `act` per picked id, each under a [`kit_act::fresh`] key: a batch that
//! half-committed leaves exactly the photographs that did not land, and the
//! core runs one key once, so a repeated tap is never a silent replay.
//!
//! ## What a batch does to the selection
//!
//! Two policies, because the two surfaces differ ([`Drain`]). A SHELF drains the
//! set as photographs settle: those that committed leave, those the vault
//! refused stay picked, which is both the honest state and the one a member can
//! retry from. The LIBRARY ends the mode as a trash or an album write goes (every
//! photograph picked is on its way out of the grid, and a bar still counting
//! them would be counting nothing), but keeps the set after a favourite:
//! favouriting is not the end of a member's job with it.
//!
//! The refusal is the vault's own sentence, held beside the set and never in the
//! read's `Failure`, so a refused favourite does not replace the grid with an
//! error.

use centraid_api_proto::core_v1 as wire;
use wire::photos_selection_event::Kind as E;

use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::screen::Ctx;
use crate::strings::{Locale, photos as words};

/// A bar verb.
pub use wire::photos_batch_action::Kind as Verb;

/// Which verbs the bar offers: the set depends on where the photographs are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Offer {
    /// The library grid: favourite or unfavourite (one value for the whole
    /// selection), add to album, trash.
    Library,
    /// A shelf of live photographs (videos, a place, the unplaced): favourite and
    /// unfavourite, add to album, archive, trash.
    Shelf,
    /// The favourites shelf: unfavourite instead of favourite.
    Favorites,
    /// The archive: unarchive instead of archive.
    Archive,
    /// The trash: restore and delete forever, nothing else.
    Trash,
    /// An album (by id): a shelf, and remove from album.
    Album(String),
}

impl Offer {
    /// The verbs, in draw order.
    #[must_use]
    pub fn verbs(&self) -> Vec<Verb> {
        match self {
            Self::Library => vec![
                Verb::Favorite,
                Verb::Unfavorite,
                Verb::AddToAlbum,
                Verb::Trash,
            ],
            Self::Shelf => vec![
                Verb::Favorite,
                Verb::AddToAlbum,
                Verb::Archive,
                Verb::Trash,
                Verb::Unfavorite,
            ],
            Self::Favorites => vec![
                Verb::Unfavorite,
                Verb::AddToAlbum,
                Verb::Archive,
                Verb::Trash,
            ],
            Self::Archive => vec![
                Verb::Favorite,
                Verb::AddToAlbum,
                Verb::Unarchive,
                Verb::Trash,
            ],
            Self::Trash => vec![Verb::Restore, Verb::DeleteForever],
            Self::Album(_) => vec![
                Verb::Favorite,
                Verb::AddToAlbum,
                Verb::Archive,
                Verb::Trash,
                Verb::Unfavorite,
                Verb::RemoveFromAlbum,
            ],
        }
    }

    fn album(&self) -> Option<&str> {
        match self {
            Self::Album(id) => Some(id),
            _ => None,
        }
    }

    fn is_archive(&self) -> bool {
        matches!(self, Self::Archive)
    }
}

/// What a batch does to the selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drain {
    /// A shelf: photographs that committed leave the set; the mode ends when the
    /// set is empty.
    Settled,
    /// The library: a trash, an archive or an album write ends the mode; a
    /// favourite keeps the set.
    Ends,
}

/// How the bar counts: the grid says "3 photos selected", a shelf "3 chosen".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wording {
    Selected,
    Chosen,
}

/// What a run of per-photograph writes came to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Written {
    /// The photographs whose write committed.
    pub committed: Vec<String>,
    /// The first refusal's sentence, the vault's own.
    pub refusal: Option<String>,
}

impl Written {
    #[must_use]
    pub fn ok(&self) -> bool {
        self.refusal.is_none()
    }
}

/// One `act` per id, each under a fresh key naming the verb and the photograph.
pub fn each(
    ctx: &Ctx,
    ids: &[String],
    verb: &str,
    request: impl Fn(&str) -> wire::ActRequest,
) -> Written {
    let mut written = Written::default();
    for id in ids {
        let key = kit_act::key(&[verb, id], kit_act::fresh());
        let settled = kit_act::act(ctx, request(id), &key);
        if settled.committed {
            written.committed.push(id.clone());
        } else if written.refusal.is_none() {
            written.refusal = Some(settled.refusal);
        }
    }
    written
}

/// What a selection event came to, for the screen to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Only the selection moved.
    Moved,
    /// "Add to album" was tapped over a pick: the screen opens its album sheet.
    OpenAlbumChoice,
    /// A batch ran; the screen reads again.
    Wrote(Written),
}

/// The mode, the set, the confirm and the refusal.
#[derive(Clone, Debug)]
pub struct Selection {
    offer: Offer,
    drain: Drain,
    wording: Wording,
    selecting: bool,
    picked: Vec<String>,
    confirming: Option<Verb>,
    refusal: Option<String>,
}

impl Selection {
    #[must_use]
    pub fn new(offer: Offer, drain: Drain, wording: Wording) -> Self {
        Self {
            offer,
            drain,
            wording,
            selecting: false,
            picked: Vec::new(),
            confirming: None,
            refusal: None,
        }
    }

    #[must_use]
    pub fn selecting(&self) -> bool {
        self.selecting
    }

    /// The picked photographs, in the order picked.
    #[must_use]
    pub fn picked(&self) -> &[String] {
        &self.picked
    }

    #[must_use]
    pub fn is_picked(&self, id: &str) -> bool {
        self.picked.iter().any(|picked| picked == id)
    }

    #[must_use]
    pub fn offer(&self) -> &Offer {
        &self.offer
    }

    /// Where the photographs are changed (a shelf whose kind a screen set late).
    pub fn set_offer(&mut self, offer: Offer) {
        self.offer = offer;
    }

    /// Enter the mode with nothing picked, or leave it: leaving empties the set
    /// and takes back a confirm that was asking about it.
    pub fn set_mode(&mut self, selecting: bool) {
        self.selecting = selecting;
        self.picked.clear();
        self.confirming = None;
        self.refusal = None;
    }

    /// Leave the mode.
    pub fn leave(&mut self) {
        self.set_mode(false);
    }

    /// A tap while selecting, or a long press, which enters the mode WITH that
    /// photograph picked.
    pub fn toggle(&mut self, id: &str) {
        if let Some(at) = self.picked.iter().position(|picked| picked == id) {
            self.picked.remove(at);
        } else {
            self.picked.push(id.to_owned());
        }
        self.selecting = true;
        self.confirming = None;
    }

    /// A set joins or leaves at once, the order it was picked in kept.
    pub fn set(&mut self, ids: &[String], selected: bool) {
        if selected {
            for id in ids {
                if !self.is_picked(id) {
                    self.picked.push(id.clone());
                }
            }
        } else {
            self.picked.retain(|picked| !ids.contains(picked));
        }
        self.selecting = true;
        self.confirming = None;
    }

    /// Every photograph in `ordered`.
    pub fn select_all(&mut self, ordered: &[String]) {
        self.set(ordered, true);
    }

    /// Everything from one photograph to another, in the order drawn, either way
    /// round. A photograph `ordered` does not hold selects nothing.
    pub fn select_range(&mut self, ordered: &[String], from: &str, to: &str) {
        let at = |id: &str| ordered.iter().position(|candidate| candidate == id);
        let (Some(first), Some(second)) = (at(from), at(to)) else {
            return;
        };
        let (low, high) = (first.min(second), first.max(second));
        self.set(&ordered[low..=high], true);
    }

    /// Keep only the picks `shown` still holds: the library drops a photograph
    /// that left the grid. A SHELF does not call this: its pick survives a page
    /// it has not loaded.
    pub fn retain_in(&mut self, shown: &[String]) {
        self.picked.retain(|picked| shown.contains(picked));
    }

    /// The vault's sentence for a refused write, until the next attempt.
    #[must_use]
    pub fn refusal(&self) -> Option<&str> {
        self.refusal.as_deref()
    }

    /// The refusal as the kit's status line.
    #[must_use]
    pub fn status(&self) -> Option<wire::StatusLine> {
        self.refusal.as_ref().map(|sentence| wire::StatusLine {
            sentence: sentence.clone(),
            action_label: String::new(),
            refused: true,
        })
    }

    /// Record a refusal from a write this selection did not run (the album
    /// sheet's), so one line says what the last attempt came to.
    pub fn refuse(&mut self, sentence: Option<String>) {
        self.refusal = sentence;
    }

    /// Apply the finished `Written` of a write over the picked set
    /// ([`Selection::apply`] for the album sheet's add).
    pub fn settle(&mut self, written: &Written, verb: Verb) {
        self.refusal.clone_from(&written.refusal);
        self.confirming = None;
        match self.drain {
            Drain::Settled => {
                self.picked
                    .retain(|picked| !written.committed.contains(picked));
                if self.picked.is_empty() {
                    self.selecting = false;
                }
            }
            Drain::Ends => {
                if !matches!(verb, Verb::Favorite | Verb::Unfavorite) {
                    let refusal = self.refusal.take();
                    self.leave();
                    self.refusal = refusal;
                }
            }
        }
    }

    /// Take one selection event. `ordered` is the photographs the screen draws,
    /// in draw order (for All and Range).
    pub fn update(
        &mut self,
        event: &wire::PhotosSelectionEvent,
        ordered: &[String],
        ctx: &Ctx,
    ) -> Outcome {
        match &event.kind {
            Some(E::Mode(mode)) => self.set_mode(mode.selecting),
            Some(E::Toggled(toggled)) => self.toggle(&toggled.photo_id),
            Some(E::Set(set)) => self.set(&set.photo_ids, set.selected),
            Some(E::All(_)) => self.select_all(ordered),
            Some(E::Range(range)) => {
                self.select_range(ordered, &range.from_photo_id, &range.to_photo_id);
            }
            Some(E::Action(tapped)) => {
                return self.tapped(
                    Verb::try_from(tapped.kind).unwrap_or(Verb::Unspecified),
                    ctx,
                );
            }
            Some(E::Confirmed(_)) => {
                if let Some(verb) = self.confirming.take() {
                    return self.run(verb, ctx);
                }
            }
            Some(E::Dismissed(_)) => self.confirming = None,
            None => {}
        }
        Outcome::Moved
    }

    fn tapped(&mut self, verb: Verb, ctx: &Ctx) -> Outcome {
        // The archive's way out is `unarchive`, however the screen spelt it.
        let verb = if verb == Verb::Restore && self.offer.is_archive() {
            Verb::Unarchive
        } else {
            verb
        };
        if self.picked.is_empty() || !self.offer.verbs().contains(&verb) {
            return Outcome::Moved;
        }
        self.refusal = None;
        match verb {
            // Destroying and trashing ask first, in full sentences.
            Verb::Trash | Verb::DeleteForever => {
                self.confirming = Some(verb);
                Outcome::Moved
            }
            Verb::AddToAlbum => {
                self.confirming = None;
                Outcome::OpenAlbumChoice
            }
            Verb::Unspecified => Outcome::Moved,
            _ => self.run(verb, ctx),
        }
    }

    /// Run `verb` over the picked set.
    fn run(&mut self, verb: Verb, ctx: &Ctx) -> Outcome {
        let ids = self.picked.clone();
        let album = self.offer.album().unwrap_or_default().to_owned();
        let archive = self.offer.is_archive();
        let written = match verb {
            Verb::Favorite => each(ctx, &ids, "flag-photo", |id| {
                act::photos::FlagPhoto {
                    photo_id: id.to_owned(),
                }
                .into()
            }),
            Verb::Unfavorite => each(ctx, &ids, "unflag-photo", |id| {
                act::photos::UnflagPhoto {
                    photo_id: id.to_owned(),
                }
                .into()
            }),
            Verb::Archive => each(ctx, &ids, "archive-photo", |id| {
                act::photos::ArchivePhoto {
                    photo_id: id.to_owned(),
                }
                .into()
            }),
            // An archived photograph was never deleted: out of the archive is
            // `unarchive`, and `restore` would be refused for it.
            Verb::Unarchive => each(ctx, &ids, "unarchive-photo", unarchive),
            Verb::Restore if archive => each(ctx, &ids, "unarchive-photo", unarchive),
            Verb::Restore => each(ctx, &ids, "restore-photo", |id| {
                act::photos::RestorePhoto {
                    photo_id: id.to_owned(),
                }
                .into()
            }),
            Verb::Trash => each(ctx, &ids, "delete-photo", |id| {
                act::photos::DeletePhoto {
                    photo_id: id.to_owned(),
                }
                .into()
            }),
            Verb::DeleteForever => each(ctx, &ids, "purge-photo", |id| {
                act::photos::PurgePhoto {
                    photo_id: id.to_owned(),
                }
                .into()
            }),
            Verb::RemoveFromAlbum if !album.is_empty() => {
                each(ctx, &ids, "remove-from-album", |id| {
                    act::photos::RemoveFromAlbum {
                        from: album.clone(),
                        to: id.to_owned(),
                    }
                    .into()
                })
            }
            Verb::RemoveFromAlbum | Verb::AddToAlbum | Verb::Unspecified => return Outcome::Moved,
        };
        self.settle(&written, verb);
        Outcome::Wrote(written)
    }

    /// The bar, finished.
    #[must_use]
    pub fn view(&self, locale: Locale) -> wire::PhotosSelection {
        let count = u32::try_from(self.picked.len()).unwrap_or(u32::MAX);
        let enabled = count > 0;
        let actions = self
            .offer
            .verbs()
            .into_iter()
            .map(|kind| wire::PhotosBatchAction {
                kind: kind as i32,
                label: label(locale, kind),
                enabled,
                destructive: matches!(kind, Verb::Trash | Verb::DeleteForever),
            })
            .collect();
        let title = match (enabled, self.wording) {
            (false, _) => String::new(),
            (true, Wording::Selected) => words::selected_title(locale, u64::from(count)),
            (true, Wording::Chosen) => words::chosen_title(locale, u64::from(count)),
        };
        wire::PhotosSelection {
            selecting: self.selecting,
            selected_ids: self.picked.clone(),
            count,
            title,
            actions,
            cancel_label: words::photos_cancel(locale),
            confirm: self.confirming.map(|verb| confirm(locale, verb, count)),
            confirming: self.confirming.unwrap_or(Verb::Unspecified) as i32,
        }
    }
}

fn unarchive(id: &str) -> wire::ActRequest {
    act::photos::UnarchivePhoto {
        photo_id: id.to_owned(),
    }
    .into()
}

/// A verb's word on the bar.
#[must_use]
pub fn label(locale: Locale, verb: Verb) -> String {
    match verb {
        Verb::Favorite => words::photos_favorite(locale),
        Verb::Unfavorite => words::photos_unfavorite(locale),
        Verb::Archive => words::photos_archive(locale),
        Verb::Unarchive => words::photos_unarchive(locale),
        Verb::Trash => words::photos_trash(locale),
        Verb::Restore => words::photos_restore(locale),
        Verb::DeleteForever => words::photos_delete_forever(locale),
        Verb::AddToAlbum => words::photos_add_to_album(locale),
        Verb::RemoveFromAlbum => words::photos_remove_from_album(locale),
        Verb::Unspecified => String::new(),
    }
}

/// The confirm over a destructive verb, with the whole cost stated: not only the
/// photograph but its captions, tags and album entries.
fn confirm(locale: Locale, verb: Verb, count: u32) -> wire::Confirm {
    let n = u64::from(count);
    match verb {
        Verb::DeleteForever => wire::Confirm {
            title: words::delete_forever_question(locale, n),
            body: words::photos_delete_forever_body(locale),
            confirm_label: words::delete_forever_label(locale, n),
            destructive: true,
        },
        _ => wire::Confirm {
            title: words::trash_question(locale, n),
            body: words::photos_trash_body(locale),
            confirm_label: words::photos_grid_trash_confirm(locale),
            destructive: true,
        },
    }
}
