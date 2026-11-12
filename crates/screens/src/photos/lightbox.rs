//! `photos.lightbox` (#1135): one photograph, its film strip, and everything this
//! phone knows of it: caption, tags, place, albums, the bytes' whereabouts, the
//! verbs that can run and the reason one cannot.
//!
//! ## What a swipe is
//!
//! The route carries the order of the shelf that opened this screen
//! (`neighbour_ids`), so a swipe is a [`K::Moved`] and never a read of the shelf:
//! a lightbox that re-read its neighbours on every swipe would page the library
//! once per photograph a member flicked past. The strip is a window of
//! [`FILM_REACH`] either side, read once per frame and kept.
//!
//! ## Verbs and refusals
//!
//! No verb is enabled without being able to run and none is disabled without a
//! reason ([`verbs`]). A write over a screen with no photograph read is withheld
//! with [`own::not_in_vault`] and never submitted. A refused write is a
//! [`wire::StatusLine`] beside the photograph, never the read's `Failure`: a
//! denied favourite must not take the picture off the screen.
//!
//! ## Platform work
//!
//! The original's file comes from `Ctx::content_urls`; the pixels, the share
//! sheet and the library save are effects (`ExportOriginals`, `ReadCamera`),
//! answered by `EffectResult`; the original back from a gateway is the core's
//! `fetch_original`, asked off the lock (`fetch::start`). A fetch that landed
//! re-reads, so the next read serves the original; one that did not names why.
//!
//! Dropped with the Kotlin machine: the seat, the six read legs and their
//! amendment merge (one `photos.photo` answer holds the photograph), the
//! unread-parts marks (a failed read is a failure; nothing is half-read), the
//! film's per-shelf legs, and `HELD_FETCHING`'s percentage (nothing reports one).
//! The share sheet's "place name only" row is gone: the platform's export
//! carries the file or the file without its location, and a name has no file to
//! ride in.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photo_tile::Held;
use wire::photos_lightbox_event::Kind as K;
use wire::photos_lightbox_share_choice::Precision;
use wire::photos_lightbox_state::Sheet;
use wire::photos_lightbox_verb::Kind as V;
use wire::screen_event::Kind as E;

use super::album_choice::{AlbumChoice, Outcome as AlbumOutcome};
use super::cells::{self, Link};
use super::{editor, fetch, media, routes};
use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::attachments::Attachments;
use crate::kit::civil::HourCycle;
use crate::kit::earlier;
use crate::kit::links::{self, Kind, Links, Outcome};
use crate::kit::owner::{Answer as Owner, Leaving, NoPasscode, OwnerGate};
use crate::kit::quantity::{Quantity, UnitsPref};
use crate::kit::read::{self, Page, Reading};
use crate::kit::stale;
use crate::kit::trash;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, chat_confirm, fill, photos as words, photos_lightbox as own,
    photos_shelf as shelf_words, shared,
};

/// How far either side of the photograph on screen the strip is read.
pub const FILM_REACH: usize = 12;
/// A promise and not a taste: the slideshow's meta line prints this number.
pub const SLIDESHOW_INTERVAL: Duration = Duration::from_secs(4);
const SLIDESHOW_TIMER: &str = "slideshow";

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PhotosLightbox(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Lightbox {
        gate: OwnerGate::default(),
        sending: Precision::None,
        photo_id: args.photo_id.clone(),
        neighbours: args.neighbour_ids.clone(),
        album_id: args.album_id.clone(),
        content: Page::loading(),
        located: Located::default(),
        camera: None,
        film: HashMap::new(),
        chrome_visible: true,
        sheet: Sheet::None,
        slideshow: false,
        undo: Undo::default(),
        albums: AlbumChoice::for_one_photo(),
        places: Vec::new(),
        confirm: false,
        fetching: false,
        dismissed: false,
        pending: VecDeque::new(),
        links: Links::new(&[Kind::Person]),
        // A photograph may link to another photograph; the picker leaves this one out.
        every: Links::new(&Kind::ALL).for_entity(&args.photo_id),
        linked: None,
        linked_unread: false,
        attachments: Attachments::of("photos", &args.photo_id),
        earlier: earlier::Foot::default(),
        rev: None,
        stale: None,
    }))
}

/// The window of neighbours around `photo_id`: empty when it is not on the shelf
/// or the shelf is one.
#[must_use]
pub fn film_window<'a>(neighbours: &'a [String], photo_id: &str) -> &'a [String] {
    let Some(at) = neighbours.iter().position(|id| id == photo_id) else {
        return &[];
    };
    if neighbours.len() <= 1 {
        return &[];
    }
    let from = at.saturating_sub(FILM_REACH);
    let to = (at + FILM_REACH + 1).min(neighbours.len());
    &neighbours[from..to]
}

/// `UTC+01:00`: the zone as a signed offset from Greenwich.
#[must_use]
pub fn offset_label(minutes: i64) -> String {
    let total = minutes.abs();
    format!(
        "UTC{}{:02}:{:02}",
        if minutes < 0 { "-" } else { "+" },
        total / 60,
        total % 60
    )
}

struct Detail {
    cell: wire::PhotosCell,
    trashed: bool,
    tags: Vec<wire::PhotosTag>,
    place: Option<wire::PhotosPlaceCard>,
    /// Who the member says is in it (`people.links`), tagged by hand.
    people: Vec<wire::PeopleLinked>,
}

/// Where the bytes are on this phone, as the content door located them.
#[derive(Default)]
struct Located {
    /// The photograph this belongs to: an answer for another is dropped.
    photo_id: String,
    original_path: Option<String>,
    embeddable: bool,
    media_type: String,
    live_path: Option<String>,
}

/// An effect asked and not yet answered.
enum Pending {
    Export { save: bool, precision: Precision },
    Camera(String),
}

struct Lightbox {
    /// The owner check a send asks first (a copy saved to this phone's own
    /// library does not leave it); no passcode warns and goes ahead.
    gate: OwnerGate,
    /// The precision the send waits on while the check is up.
    sending: Precision,
    photo_id: String,
    neighbours: Vec<String>,
    album_id: String,
    /// The read of this photograph: its detail is the page's data. A failed re-read keeps the
    /// photograph on screen under a note.
    content: Page<Box<Detail>>,
    located: Located,
    /// The camera the original's header names, for one photograph.
    camera: Option<(String, String)>,
    film: HashMap<String, wire::PhotosCell>,
    chrome_visible: bool,
    sheet: Sheet,
    slideshow: bool,
    /// The status line and what its Undo reverses (the kit's one door).
    undo: Undo,
    albums: AlbumChoice,
    places: Vec<wire::PhotosPlaceCard>,
    confirm: bool,
    fetching: bool,
    dismissed: bool,
    pending: VecDeque<Pending>,
    /// The people picker (#1173).
    links: Links,
    /// THE "Linked to" SECTION'S PICKER (#1185): what the photograph can link to, any item but a
    /// Locker one ("People in this photo", above, is people only and says who is in it).
    every: Links,
    /// What the photograph is linked to, either end (`links::read_linked`). `None` until read,
    /// and while a read did not land.
    linked: Option<Vec<wire::LinkedItem>>,
    /// The read of `linked` was refused or failed: the status line says so, no empty section.
    linked_unread: bool,
    /// The photos and files on the photograph (#1185): the kit's section, read with it.
    attachments: Attachments,
    /// The entry to the photograph's earlier versions, read with it (#1185).
    earlier: earlier::Foot,
    /// The photograph's revision when the page was last read: what a caption names as the one it
    /// replaces (#1185).
    rev: Option<i64>,
    /// Why the vault refused the last write, when the photograph had changed (or gone to the
    /// trash) since it was read.
    stale: Option<stale::Stale>,
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

impl Lightbox {
    // ---- reads ----

    fn load_cell(ctx: &Ctx, id: &str) -> Reading<Box<wire::PhotosPhoto>> {
        read::read(
            ctx,
            load::photos::Photo { id: id.to_owned() },
            |answer| match answer {
                Answer::PhotosPhoto(found) => Some(found),
                _ => None,
            },
        )
    }

    /// Read this photograph. A failed re-read keeps the photograph on screen: only
    /// a first read that failed has nothing else to show.
    fn reload(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        // The revision first: a change between the two reads refuses the next save.
        self.rev = stale::read_rev(ctx, &self.photo_id);
        match Self::load_cell(ctx, &self.photo_id) {
            Reading::Data(found) => match found.photo {
                Some(detail) => {
                    let Some(cell) = detail.cell else {
                        self.content = Page::Failed;
                        return Vec::new();
                    };
                    let people = match links::read_people(ctx, &self.photo_id) {
                        Reading::Data(people) => people,
                        _ => match self.content.data() {
                            Some(old) if old.cell.photo_id == cell.photo_id => old.people.clone(),
                            _ => Vec::new(),
                        },
                    };
                    self.content = Page::Ready {
                        data: Box::new(Detail {
                            cell,
                            trashed: detail.trashed,
                            tags: detail.tags,
                            place: detail.place,
                            people,
                        }),
                        note: None,
                    };
                }
                // No such photograph: gone (deleted forever here or elsewhere).
                None => {
                    if self.content.data().is_some() {
                        self.dismissed = true;
                    } else {
                        self.content = Page::Failed;
                    }
                }
            },
            Reading::Denied(denial) => self.content = Page::Refused(denial),
            Reading::Failed => {
                let held = std::mem::replace(&mut self.content, Page::loading());
                self.content = held.after(Reading::Failed, ctx.locale(), |_| false);
            }
        }
        self.earlier = self.read_foot(ctx);
        self.read_linked(ctx);
        if self.detail().is_some_and(|detail| !detail.trashed) {
            self.attachments.reload(ctx);
        }
        self.locate(ctx);
        self.fill_film(ctx);
        self.camera_effects()
    }

    /// What the photograph is linked to, in both directions. A refused or failed read is said on
    /// the status line and never drawn as an empty section; a photograph that was not read or is
    /// in the trash has none ("People in this photo" is the same).
    fn read_linked(&mut self, ctx: &Ctx) {
        if self.detail().is_none_or(|detail| detail.trashed) {
            self.linked = None;
            self.linked_unread = false;
            self.every.close();
            return;
        }
        match links::read_linked(ctx, &self.photo_id) {
            Reading::Data(items) => {
                self.linked = Some(items);
                self.linked_unread = false;
            }
            Reading::Denied(_) | Reading::Failed => {
                self.linked = None;
                self.linked_unread = true;
                self.every.close();
            }
        }
        self.every.reload(ctx);
    }

    fn linked_ids(&self) -> Vec<String> {
        self.linked.as_deref().map(links::ids).unwrap_or_default()
    }

    /// One tap in the "Linked to" section or its picker. `add-person` and `remove-person` carry
    /// rel `links` for every kind, a person included, as a link and not as who is in the photo.
    fn link_event(&mut self, event: &wire::LinkEvent, ctx: &Ctx) {
        let linked = self.linked_ids();
        let id = self.photo_id.clone();
        match self.every.update(event, &linked, ctx) {
            Outcome::Add { id: to, .. } => {
                self.write(
                    ctx,
                    "add-link",
                    &[&id, &to],
                    act::photos::AddPerson {
                        from: id.clone(),
                        rel: act::photos::AddPersonRel::Links,
                        to: to.clone(),
                    },
                    Some(own::link_added(ctx.locale())),
                );
            }
            Outcome::Remove { id: to } => {
                self.write(
                    ctx,
                    "remove-link",
                    &[&id, &to],
                    act::photos::RemovePerson {
                        from: id.clone(),
                        rel: act::photos::RemovePersonRel::Links,
                        to: to.clone(),
                    },
                    Some(own::link_removed(ctx.locale())),
                );
            }
            Outcome::Moved => {}
        }
    }

    /// The entry to this photograph's earlier versions: only a photograph that was read has one.
    fn read_foot(&self, ctx: &Ctx) -> earlier::Foot {
        let Some(detail) = self.content.data() else {
            return earlier::Foot::default();
        };
        let cell = &detail.cell;
        let locale = ctx.locale();
        let offset = cell.offset_min.unwrap_or(0);
        let back = [
            cell.title.trim().to_owned(),
            cell.taken_at
                .as_deref()
                .map(|at| media::stamp_date(locale, at, offset))
                .unwrap_or_default(),
            own::edit_fallback_name(locale),
        ]
        .into_iter()
        .find(|name| !name.is_empty())
        .unwrap_or_default();
        earlier::foot(ctx, super::EARLIER, &self.photo_id, &back)
    }

    /// The original's file and a Live Photo's movie, once this phone holds them.
    fn locate(&mut self, ctx: &Ctx) {
        let Some(detail) = self.content.data() else {
            return;
        };
        let cell = &detail.cell;
        let mut located = Located {
            photo_id: cell.photo_id.clone(),
            ..Located::default()
        };
        if cell.original_held && !cell.content_id.is_empty() {
            let mut refs = vec![wire::ContentRef {
                content_id: cell.content_id.clone(),
                owner_type: "photo".to_owned(),
                owner_id: cell.photo_id.clone(),
            }];
            let movie = cell
                .live_content_id
                .clone()
                .zip(cell.live_movie_id.clone())
                .filter(|(content, _)| !content.is_empty());
            if let Some((content_id, owner_id)) = &movie {
                refs.push(wire::ContentRef {
                    content_id: content_id.clone(),
                    owner_type: "photo".to_owned(),
                    owner_id: owner_id.clone(),
                });
            }
            // A FAILED LOOKUP IS NOT A FAILED PHOTOGRAPH: the thumbnail stays.
            if let Ok(urls) = ctx.content_urls(&wire::ContentUrlRequest { refs }) {
                let mut urls = urls.urls.into_iter();
                if let Some(original) = urls.next() {
                    located.original_path = original.path.filter(|path| !path.is_empty());
                    located.embeddable = original.embeddable;
                    located.media_type = original.media_type;
                }
                if let (Some(_), Some(live)) = (movie, urls.next()) {
                    located.live_path = live.path.filter(|_| live.embeddable);
                }
            }
        }
        self.located = located;
    }

    /// Read the strip's frames this screen does not hold, and refresh the ones it
    /// does (a download changes what a frame holds).
    fn fill_film(&mut self, ctx: &Ctx) {
        let window: Vec<String> = film_window(&self.neighbours, &self.photo_id).to_vec();
        self.film.retain(|id, _| window.contains(id));
        for id in window {
            if id == self.photo_id {
                continue;
            }
            if let Reading::Data(found) = Self::load_cell(ctx, &id)
                && let Some(cell) = found.photo.and_then(|detail| detail.cell)
            {
                self.film.insert(id, cell);
            }
        }
    }

    /// Ask the platform to read the camera off the original, once per photograph.
    fn camera_effects(&mut self) -> Vec<wire::Effect> {
        let Some(path) = self.located.original_path.clone() else {
            return Vec::new();
        };
        if self
            .camera
            .as_ref()
            .is_some_and(|(id, _)| *id == self.photo_id)
            || self
                .pending
                .iter()
                .any(|p| matches!(p, Pending::Camera(id) if *id == self.photo_id))
        {
            return Vec::new();
        }
        self.pending
            .push_back(Pending::Camera(self.photo_id.clone()));
        vec![effect(wire::effect::Kind::ReadCamera(wire::ReadCamera {
            path,
        }))]
    }

    fn read_places(&mut self, ctx: &Ctx) {
        let reading = read::read(
            ctx,
            load::photos::Places::default(),
            |answer| match answer {
                Answer::PhotosPlaces(places) => Some(places),
                _ => None,
            },
        );
        // A refused list is an empty one: "No place" is still on the sheet.
        self.places = match reading {
            Reading::Data(places) => places.places,
            _ => Vec::new(),
        };
    }

    // ---- state changes ----

    /// ONE PHOTOGRAPH, FROM THE TOP. The sheet closes and the chrome comes back
    /// (navigation re-shows it); a refusal and a receipt were about the photograph
    /// they were tried on and do not travel.
    fn open(&mut self, ctx: &Ctx, photo_id: &str) -> Vec<wire::Effect> {
        self.photo_id = photo_id.to_owned();
        self.content = Page::loading();
        self.located = Located::default();
        self.chrome_visible = true;
        self.sheet = Sheet::None;
        self.undo.clear();
        self.confirm = false;
        self.fetching = false;
        self.albums.close();
        if self.slideshow {
            ctx.start_timer(SLIDESHOW_TIMER, SLIDESHOW_INTERVAL);
        }
        self.reload(ctx)
    }

    fn position(&self) -> Option<usize> {
        self.neighbours.iter().position(|id| *id == self.photo_id)
    }

    fn refusal(&self, locale: Locale) -> Option<String> {
        self.content
            .data()
            .is_none()
            .then(|| own::not_in_vault(locale))
    }

    fn refuse(&mut self, sentence: String) {
        self.undo.refuse(sentence);
    }

    /// A line with no Undo: the sentence of something that was not a write (a share, a copy).
    fn receipt(&mut self, sentence: String) {
        self.undo.say(sentence);
    }

    /// One write, behind the same ladder as every other: withheld when there is
    /// no photograph, the vault's own sentence when refused, a re-read when it
    /// committed. A new attempt clears the old sentence. `said` is what happened, with the
    /// core's Undo; `None` is a write that says nothing.
    fn write(
        &mut self,
        ctx: &Ctx,
        verb: &str,
        parts: &[&str],
        request: impl Into<wire::ActRequest>,
        said: Option<String>,
    ) -> bool {
        if let Some(why) = self.refusal(ctx.locale()) {
            self.refuse(why);
            return false;
        }
        self.undo.clear();
        let key = kit_act::key(&[&[verb], parts].concat(), kit_act::fresh());
        let settled = match said {
            Some(said) => self.undo.act(ctx, request, &key, |_| said),
            None => self.undo.act_quietly(ctx, request, &key),
        };
        self.stale = settled.stale();
        if settled.committed {
            self.reload(ctx);
        }
        settled.committed
    }

    fn people_ids(&self) -> Vec<String> {
        self.detail()
            .map(|d| d.people.iter().map(|p| p.party_id.clone()).collect())
            .unwrap_or_default()
    }

    /// One event of the "People in this photo" section or its picker.
    fn people_event(&mut self, event: &wire::LinkEvent, ctx: &Ctx) {
        let linked = self.people_ids();
        let id = self.photo_id.clone();
        match self.links.update(event, &linked, ctx) {
            Outcome::Add { id: person, .. } => {
                self.write(
                    ctx,
                    "add-person",
                    &[&id, &person],
                    act::photos::AddPerson {
                        from: id.clone(),
                        rel: act::photos::AddPersonRel::Depicts,
                        to: person.clone(),
                    },
                    Some(own::person_added(ctx.locale())),
                );
            }
            Outcome::Remove { id: person } => {
                self.write(
                    ctx,
                    "remove-person",
                    &[&id, &person],
                    act::photos::RemovePerson {
                        from: id.clone(),
                        rel: act::photos::RemovePersonRel::Depicts,
                        to: person.clone(),
                    },
                    Some(own::person_removed(ctx.locale())),
                );
            }
            Outcome::Moved => {}
        }
    }

    fn detail(&self) -> Option<&Detail> {
        self.content.data().map(|detail| &**detail)
    }

    fn tap(&mut self, kind: V, ctx: &Ctx) -> Vec<wire::Effect> {
        let id = self.photo_id.clone();
        let Some(detail) = self.detail() else {
            return Vec::new();
        };
        let (favorite, archived) = (detail.cell.favorite, detail.cell.archived);
        match kind {
            V::Favorite => {
                if favorite {
                    self.write(
                        ctx,
                        "unflag-photo",
                        &[&id],
                        act::photos::UnflagPhoto {
                            photo_id: id.clone(),
                        },
                        Some(words::photos_receipt_unfavorited(ctx.locale())),
                    );
                } else {
                    self.write(
                        ctx,
                        "flag-photo",
                        &[&id],
                        act::photos::FlagPhoto {
                            photo_id: id.clone(),
                        },
                        Some(words::photos_receipt_favorited(ctx.locale())),
                    );
                }
            }
            V::Archive => {
                if archived {
                    self.write(
                        ctx,
                        "unarchive-photo",
                        &[&id],
                        act::photos::UnarchivePhoto {
                            photo_id: id.clone(),
                        },
                        Some(words::photos_receipt_unarchived(ctx.locale())),
                    );
                } else {
                    self.write(
                        ctx,
                        "archive-photo",
                        &[&id],
                        act::photos::ArchivePhoto {
                            photo_id: id.clone(),
                        },
                        Some(words::photos_receipt_archived(ctx.locale())),
                    );
                }
            }
            // THE PHOTOGRAPH STAYS ON SCREEN, so the move is said with Undo, which restores it,
            // and it never asks (#1185).
            V::Trash => {
                self.sheet = Sheet::None;
                let title = self
                    .detail()
                    .map(|detail| detail.cell.title.clone())
                    .unwrap_or_default();
                self.write(
                    ctx,
                    "delete-photo",
                    &[&id],
                    act::photos::DeletePhoto {
                        photo_id: id.clone(),
                    },
                    Some(trash::moved_to_trash(ctx.locale(), &title)),
                );
            }
            V::Restore => {
                self.write(
                    ctx,
                    "restore-photo",
                    &[&id],
                    act::photos::RestorePhoto {
                        photo_id: id.clone(),
                    },
                    Some(words::photos_receipt_restored(ctx.locale())),
                );
            }
            V::DeleteForever => self.confirm = true,
            // (i) TOGGLES THE DETAILS: they open under the photograph and the same key closes them.
            V::Info => {
                self.sheet = if self.sheet == Sheet::Info {
                    Sheet::None
                } else {
                    Sheet::Info
                };
            }
            // WHICH LOCATION TRAVELS IS ASKED ONLY OF A PHOTOGRAPH THAT HAS ONE;
            // without a place there is nothing to choose and the copy goes out bare.
            V::Share | V::SendCopy => {
                if !self.verb_enabled(ctx.locale(), V::Share) {
                    return Vec::new();
                }
                if detail.place.is_some() {
                    self.sheet = Sheet::Share;
                } else {
                    return self.export(false, Precision::None, ctx);
                }
            }
            V::Edit => {} // the shell pushes the verb's route
            V::Slideshow => {
                // A slideshow needs somewhere to go: on a shelf of one it would
                // be a mode with a clock that moves nothing.
                if self.neighbours.len() > 1 {
                    self.slideshow = true;
                    self.sheet = Sheet::None;
                    self.chrome_visible = true;
                    ctx.start_timer(SLIDESHOW_TIMER, SLIDESHOW_INTERVAL);
                }
            }
            V::AddToAlbum => {
                self.sheet = Sheet::None;
                let event = wire::PhotosAlbumChoiceEvent {
                    kind: Some(wire::photos_album_choice_event::Kind::Opened(
                        wire::photos_album_choice_event::Opened {},
                    )),
                };
                self.album_event(&event, ctx);
            }
            V::MakeKey => {
                // A cover is chosen from an album's members: without the album
                // this was opened from there is no cover to set.
                if !self.album_id.is_empty() {
                    self.sheet = Sheet::None;
                    let album = self.album_id.clone();
                    self.write(
                        ctx,
                        "set-album-cover",
                        &[&album, &id],
                        act::photos::SetAlbumCover {
                            album_id: album.clone(),
                            photo_id: Field::Is(id.clone()),
                        },
                        Some(shelf_words::cover_changed(ctx.locale())),
                    );
                }
            }
            V::AdjustLocation => {
                self.read_places(ctx);
                self.sheet = Sheet::Place;
            }
            V::Download => {
                self.sheet = Sheet::None;
                return self.export(true, Precision::Exact, ctx);
            }
            V::Unspecified => {}
        }
        Vec::new()
    }

    fn album_event(&mut self, event: &wire::PhotosAlbumChoiceEvent, ctx: &Ctx) {
        if let Some(why) = self.refusal(ctx.locale()) {
            self.refuse(why);
            return;
        }
        let picked = [self.photo_id.clone()];
        // The sheet writes through the door: "Added to <album>." with Undo, or the refusal.
        match self.albums.update(event, &picked, &mut self.undo, ctx) {
            AlbumOutcome::Moved | AlbumOutcome::Created { .. } => {}
            AlbumOutcome::Added { .. } => {
                self.reload(ctx);
            }
        }
    }

    // ---- platform work ----

    fn fetch(&mut self, ctx: &Ctx) {
        let Some(detail) = self.detail() else {
            return;
        };
        let hash = detail.cell.content_id.clone();
        if detail.cell.original_held || hash.is_empty() || self.fetching {
            return;
        }
        // The state goes to fetching HERE and not when the answer comes back: the
        // round trip is the whole wait, and an affordance that stays un-pressed
        // until it finishes is one a member taps again.
        if fetch::start(ctx, &hash) {
            self.fetching = true;
            self.undo.clear();
        }
    }

    /// The core answered a fetch (`fetch::start`).
    fn fetched(&mut self, done: &wire::OffThreadDone, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(fetched) = fetch::answered(done) else {
            return Vec::new();
        };
        if !self.fetching {
            return Vec::new();
        }
        self.fetching = false;
        match fetch::settle(ctx.locale(), &fetched) {
            Ok(()) => self.reload(ctx),
            Err(sentence) => {
                self.refuse(sentence);
                Vec::new()
            }
        }
    }

    /// A copy for the platform. SENDING ASKS THE OWNER CHECK FIRST (the bytes
    /// leave the phone); saving to this phone's own library does not.
    fn export(&mut self, save: bool, precision: Precision, ctx: &Ctx) -> Vec<wire::Effect> {
        if save || self.detail().is_none() {
            return self.hand_over(save, precision, ctx.locale());
        }
        self.undo.clear();
        self.sending = precision;
        self.gate.begin(ctx.locale(), Leaving::Share)
    }

    fn hand_over(&mut self, save: bool, precision: Precision, locale: Locale) -> Vec<wire::Effect> {
        let Some(detail) = self.detail() else {
            return Vec::new();
        };
        let id = detail.cell.photo_id.clone();
        self.undo.clear();
        self.pending.push_back(Pending::Export { save, precision });
        vec![effect(wire::effect::Kind::ExportOriginals(
            super::export_originals(
                locale,
                vec![id],
                if save {
                    wire::export_originals::Mode::Save
                } else {
                    wire::export_originals::Mode::Send
                },
                precision == Precision::Exact,
            ),
        ))]
    }

    /// The owner check's answer for a send.
    fn checked(&mut self, checked: &wire::OwnerChecked, locale: Locale) -> Vec<wire::Effect> {
        match self.gate.answer(locale, NoPasscode::Warn, checked) {
            Some(Owner::Passed) => self.hand_over(false, self.sending, locale),
            Some(Owner::PassedUnprotected(warning)) => {
                let effects = self.hand_over(false, self.sending, locale);
                self.receipt(warning);
                effects
            }
            Some(Owner::Refused(sentence)) => {
                self.refuse(sentence);
                Vec::new()
            }
            Some(Owner::Cancelled) | None => Vec::new(),
        }
    }

    fn effect_result(&mut self, result: &wire::EffectResult, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome as O;
        let locale = ctx.locale();
        // Results are matched by what they are; a bare failure belongs to the
        // oldest thing asked.
        let wanted = |pending: &Pending| match &result.outcome {
            Some(O::OriginalsExported(_)) => matches!(pending, Pending::Export { .. }),
            Some(O::CameraRead(_)) => matches!(pending, Pending::Camera(_)),
            _ => true,
        };
        // A bare failure belongs to the oldest thing a member is waiting on: a
        // fetch or an export before the camera read nobody asked for.
        let bare = !matches!(
            &result.outcome,
            Some(O::OriginalsExported(_) | O::CameraRead(_))
        );
        let at = if bare {
            self.pending
                .iter()
                .position(|p| !matches!(p, Pending::Camera(_)))
                .or_else(|| self.pending.iter().position(wanted))
        } else {
            self.pending.iter().position(wanted)
        };
        let Some(at) = at else {
            return Vec::new();
        };
        let Some(pending) = self.pending.remove(at) else {
            return Vec::new();
        };
        match pending {
            Pending::Export { save, precision } => {
                let sentence = export_sentence(locale, result, save, precision);
                match sentence {
                    Ok(receipt) => self.receipt(receipt),
                    Err(sentence) => self.refuse(sentence),
                }
            }
            Pending::Camera(id) => {
                if let Some(O::CameraRead(read)) = &result.outcome
                    && !read.camera.is_empty()
                {
                    self.camera = Some((id, read.camera.clone()));
                }
            }
        }
        Vec::new()
    }

    // ---- the view ----

    fn tile(&self, cell: &wire::PhotosCell, locale: Locale) -> wire::PhotoTile {
        let mut tile = cells::tile(cell, Link::default(), locale);
        if self.fetching && cell.photo_id == self.photo_id && !cell.original_held {
            tile.held = Held::Fetching as i32;
        }
        tile
    }

    fn photo(
        &self,
        detail: &Detail,
        locale: Locale,
        units: UnitsPref,
        cycle: HourCycle,
    ) -> wire::PhotosLightboxPhoto {
        let cell = &detail.cell;
        let tile = self.tile(cell, locale);
        let held = Held::try_from(tile.held).unwrap_or(Held::Unspecified);
        let offers_fetch = !cell.original_held && !cell.content_id.is_empty() && !self.fetching;
        let video = tile.kind == wire::photo_tile::Kind::Video as i32;
        let status_line = |playing: bool| match held {
            Held::Fetching => words::photos_original_downloading(locale),
            Held::WithheldByRule => words::photos_original_held_back(locale),
            Held::Absent => words::photos_nothing_on_phone(locale),
            _ if video && !playing && !cell.original_held => words::photos_video_still_only(locale),
            Held::ThumbnailOnly if offers_fetch => words::photos_smaller_copy_only(locale),
            _ => String::new(),
        };
        let whereabouts = match held {
            Held::Original => words::photos_original_on_phone(locale),
            Held::WithheldByRule => words::photos_original_your_choice(locale),
            Held::Fetching => words::photos_original_downloading_now(locale),
            Held::Absent => words::photos_nothing_on_phone(locale),
            Held::ThumbnailOnly | Held::Unspecified => words::photos_smaller_copy_only(locale),
        };
        let offset = cell.offset_min.unwrap_or(0);
        let place_name = detail
            .place
            .as_ref()
            .and_then(|card| card.name.clone().filter(|name| !name.is_empty()))
            .unwrap_or_default();
        let clock = cell
            .taken_at
            .as_deref()
            .map(|at| cells::capture_clock(locale, at, offset, cycle))
            .unwrap_or_default();
        let stamp_line = [clock.clone(), place_name.clone()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let stamp_date = cell
            .taken_at
            .as_deref()
            .map(|at| media::stamp_date(locale, at, offset))
            .unwrap_or_default();
        let mut facts = Vec::new();
        if !stamp_date.is_empty() {
            let zone = if offset == 0 {
                own::utc(locale)
            } else {
                offset_label(offset)
            };
            let when = format!("{stamp_date} {stamp_line}");
            facts.push(wire::PhotosLightboxFact {
                label: words::photos_fact_captured(locale),
                icon_key: "Calendar".to_owned(),
                text: fill(
                    &own::captured_fact(locale),
                    &[("when", when.trim()), ("zone", &zone)],
                ),
            });
        }
        if let (Some(w), Some(h)) = (cell.width, cell.height)
            && w > 0
            && h > 0
        {
            facts.push(wire::PhotosLightboxFact {
                label: words::photos_fact_size(locale),
                icon_key: "Maximize".to_owned(),
                text: fill(
                    &own::pixel_box(locale),
                    &[("width", &w.to_string()), ("height", &h.to_string())],
                ),
            });
        }
        if video && tile.duration_seconds > 0 {
            facts.push(wire::PhotosLightboxFact {
                label: words::photos_fact_length(locale),
                icon_key: "Clock".to_owned(),
                text: cells::clock(tile.duration_seconds),
            });
        }
        if let Some(size) = cell.byte_size.filter(|size| *size > 0) {
            facts.push(wire::PhotosLightboxFact {
                label: words::photos_fact_file(locale),
                icon_key: "FileText".to_owned(),
                text: Quantity::bytes(size).words(locale, units),
            });
        }
        if let Some((_, camera)) = self.camera.as_ref().filter(|(id, _)| *id == cell.photo_id) {
            facts.push(wire::PhotosLightboxFact {
                label: words::photos_fact_camera(locale),
                icon_key: "Camera".to_owned(),
                text: camera.clone(),
            });
        }
        let labels: Vec<wire::PhotosLightboxLabel> = detail
            .tags
            .iter()
            .filter(|tag| !tag.label.is_empty())
            .map(|tag| wire::PhotosLightboxLabel {
                tag_id: tag.tag_id.clone(),
                label: tag.label.clone(),
                remove_label: fill(&words::photos_remove_item(locale), &[("label", &tag.label)]),
            })
            .collect();
        let located = (self.located.photo_id == cell.photo_id).then_some(&self.located);
        let exact = detail
            .place
            .as_ref()
            .and_then(|card| card.exact_location.clone())
            .unwrap_or_default();
        wire::PhotosLightboxPhoto {
            original_path: located.and_then(|l| l.original_path.clone()),
            original_embeddable: located.is_some_and(|l| l.embeddable),
            original_media_type: located.map(|l| l.media_type.clone()).unwrap_or_default(),
            live_path: located.and_then(|l| l.live_path.clone()),
            status_line: status_line(false),
            status_line_playing: status_line(true),
            whereabouts,
            offers_fetch,
            fetching: self.fetching,
            stamp_date,
            stamp_line,
            facts,
            caption: cell.title.clone(),
            labels_line: if labels.is_empty() {
                words::photos_labels_none(locale)
            } else {
                String::new()
            },
            labels,
            earlier: self.earlier.entry.clone(),
            origin: self.earlier.origin.clone(),
            people: Some({
                let mut section = self.links.section(
                    locale,
                    crate::strings::links::section_people_in_photo(locale),
                    links::person_rows(locale, &detail.people),
                    String::new(),
                );
                if detail.trashed {
                    section.adds.clear();
                }
                section
            }),
            attachments: (!detail.trashed).then(|| self.attachments.view(locale, units)),
            links: self.linked.as_ref().map(|linked| {
                self.every.section(
                    locale,
                    crate::strings::links::section_linked(locale),
                    links::rows(locale, linked),
                    own::links_empty(locale),
                )
            }),
            has_place: detail.place.is_some(),
            place_phrase: detail
                .place
                .as_ref()
                .map(|card| card.phrase.clone())
                .unwrap_or_else(|| words::photos_place_none(locale)),
            can_copy_location: !exact.is_empty(),
            trashed: detail.trashed,
            trash_line: match cell.purge_in_days {
                Some(days) if detail.trashed && days > 0 => {
                    own::trash_days_left(locale, u64::try_from(days).unwrap_or(0))
                }
                _ => String::new(),
            },
            stage_label: if held == Held::Absent {
                words::photos_not_on_phone(locale)
            } else {
                words::photos_preview_gone(locale)
            },
            spoken: if cell.title.trim().is_empty() {
                words::photograph(locale)
            } else {
                cell.title.trim().to_owned()
            },
            tile: Some(tile),
        }
    }

    fn words(locale: Locale) -> wire::PhotosLightboxWords {
        wire::PhotosLightboxWords {
            close: words::photos_close(locale),
            more: words::photos_more(locale),
            slideshow: words::photos_slideshow(locale),
            slideshow_leave: words::photos_slideshow_leave(locale),
            previous: words::photos_previous(locale),
            next: words::photos_next(locale),
            load_original: words::photos_load_original(locale),
            opening: shared::kit_opening(locale),
            retry: shared::kit_retry(locale),
            caption_label: words::photos_lightbox_caption(locale),
            caption_placeholder: words::photos_caption_placeholder(locale),
            labels_title: words::photos_labels(locale),
            add_label_placeholder: words::photos_add_label(locale),
            place_title: words::photos_place(locale),
            add_place: words::photos_add_place(locale),
            change: words::photos_change(locale),
            remove: words::photos_remove(locale),
            copy_location: words::photos_copy_exact_location(locale),
            share_title: words::photos_send_place_title(locale),
            place_picker_title: words::photos_adjust_location(locale),
            no_place_detail: words::photos_clear_place_detail(locale),
            place_here: words::photos_place_here(locale),
            no_places: words::photos_no_places(locale),
            info_title: words::photos_info(locale),
            filmstrip: words::photos_filmstrip(locale),
            play: words::photos_player_play(locale),
            pause: words::photos_player_pause(locale),
            player_position: words::photos_player_position(locale),
            player_position_value: words::photos_player_position_value(locale),
            play_live: words::photos_play_live(locale),
            live_badge: words::photos_live_badge(locale),
        }
    }
}

/// The sentence a finished export is owed: a receipt stated every time, `none`
/// included (silence reads as safety), or why nothing went.
fn export_sentence(
    locale: Locale,
    result: &wire::EffectResult,
    save: bool,
    precision: Precision,
) -> Result<String, String> {
    use wire::effect_result::Outcome as O;
    use wire::originals_exported::Status;
    let Some(O::OriginalsExported(exported)) = &result.outcome else {
        return Err(words::photos_error_export_failed_retry(locale));
    };
    match Status::try_from(exported.status).unwrap_or(Status::Unspecified) {
        Status::Done if save => Ok(words::photos_export_saved(locale)),
        Status::Done if precision == Precision::Exact => Ok(words::photos_sent_exact(locale)),
        Status::Done => Ok(words::photos_sent_none(locale)),
        Status::NoneHere => Err(words::photos_send_original_not_here(locale)),
        Status::LocationNotRemovable => Err(words::photos_send_not_removable(locale)),
        Status::Failed | Status::Unspecified => {
            Err(words::photos_error_export_failed_retry(locale))
        }
    }
}

/// What the screen's state adds to the verbs: whether a slideshow has somewhere to go, and whether
/// the details are open (the (i) key is drawn pressed).
#[derive(Clone, Copy)]
struct Offers {
    slideshow: bool,
    info_open: bool,
}

/// THE BOTTOM ROW AND THE "…" MENU, as data: every verb live or visibly
/// refused with the reason that says which. `refusal` is the write ladder's,
/// `edit` the editor's.
fn verbs(
    locale: Locale,
    detail: Option<&Detail>,
    refusal: Option<&str>,
    edit: Option<&str>,
    photo_id: &str,
    album_id: &str,
    offers: Offers,
) -> (Vec<wire::PhotosLightboxVerb>, Vec<wire::PhotosLightboxVerb>) {
    let verb = |kind: V, label: String, icon: &str, why: Option<&str>, on: bool| {
        wire::PhotosLightboxVerb {
            kind: kind as i32,
            label,
            icon_key: icon.to_owned(),
            enabled: why.is_none(),
            why: why.unwrap_or_default().to_owned(),
            on,
            destructive: false,
            route: None,
        }
    };
    let Some(detail) = detail else {
        return (Vec::new(), Vec::new());
    };
    if detail.trashed {
        let mut forever = verb(
            V::DeleteForever,
            shared::trash_purge(locale),
            "trash",
            refusal,
            false,
        );
        forever.destructive = true;
        return (
            vec![
                verb(
                    V::Restore,
                    shared::trash_restore(locale),
                    "restore",
                    refusal,
                    false,
                ),
                forever,
            ],
            Vec::new(),
        );
    }
    let cell = &detail.cell;
    // A COPY IS OF THE ORIGINAL: refused up front, with the reason, when this
    // phone does not hold it.
    let send = (!cell.original_held).then(|| words::photos_edit_not_on_phone(locale));
    let mut edit_verb = verb(V::Edit, words::photos_edit(locale), "Pencil", edit, false);
    edit_verb.route = Some(routes::editor(photo_id));
    let toolbar = vec![
        verb(
            V::Share,
            words::photos_send_copy(locale),
            "share",
            send.as_deref(),
            false,
        ),
        verb(
            V::Favorite,
            if cell.favorite {
                words::photos_unfavorite(locale)
            } else {
                words::photos_favorite(locale)
            },
            "Star",
            refusal,
            cell.favorite,
        ),
        verb(
            V::Info,
            words::photos_info(locale),
            "info",
            None,
            offers.info_open,
        ),
        edit_verb,
        verb(
            V::Archive,
            if cell.archived {
                words::photos_unarchive(locale)
            } else {
                words::photos_archive(locale)
            },
            "Archive",
            refusal,
            cell.archived,
        ),
        verb(
            V::Trash,
            shared::trash_move(locale),
            "trash",
            refusal,
            false,
        ),
    ];
    let mut menu = Vec::new();
    if offers.slideshow {
        menu.push(verb(
            V::Slideshow,
            words::photos_slideshow(locale),
            "Play",
            None,
            false,
        ));
    }
    menu.push(verb(
        V::AddToAlbum,
        words::photos_add_to_album(locale),
        "FolderPlus",
        refusal,
        false,
    ));
    if !album_id.is_empty() {
        menu.push(verb(
            V::MakeKey,
            words::photos_make_key(locale),
            "Star",
            refusal,
            false,
        ));
    }
    menu.push(verb(
        V::AdjustLocation,
        words::photos_adjust_location(locale),
        "MapPin",
        refusal,
        false,
    ));
    menu.push(verb(
        V::Download,
        words::photos_download(locale),
        "Download",
        send.as_deref(),
        false,
    ));
    (toolbar, menu)
}

impl Screen for Lightbox {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.dismissed {
            return Vec::new();
        }
        let locale = ctx.locale();
        match event.kind {
            Some(E::Appeared(_) | E::EnvironmentChanged(_)) => {
                let id = self.photo_id.clone();
                return self.open(ctx, &id);
            }
            Some(E::DataChanged(_)) => {
                self.albums.reload(ctx);
                // THE EDITOR ABOVE CLOSED: its line and Undo are drawn here.
                let effects = self.reload(ctx);
                self.undo.take_handed(ctx);
                return effects;
            }
            Some(E::EffectResult(result)) => {
                if self.gate.asking() {
                    use wire::effect_result::Outcome as O;
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
                        return self.checked(&checked, locale);
                    }
                }
                // The shell's answer to a pick: the attachments' (an add under way).
                if let Some(outcome) = &result.outcome
                    && let Some(effects) = self.attachments.result(ctx, outcome)
                {
                    return effects;
                }
                return self.effect_result(&result, ctx);
            }
            Some(E::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    self.reload(ctx);
                }
            }
            Some(E::Left(_)) => {
                self.undo.clear();
                return self.gate.cancel();
            }
            Some(E::OffThreadDone(done)) => return self.fetched(&done, ctx),
            Some(E::TimerFired(fired)) if fired.timer == SLIDESHOW_TIMER => {
                // IT WRAPS AT THE END OF THE SHELF: a slideshow is a loop until Leave.
                if self.slideshow
                    && self.neighbours.len() > 1
                    && let Some(at) = self.position()
                {
                    let next = self.neighbours[(at + 1) % self.neighbours.len()].clone();
                    return self.open(ctx, &next);
                }
            }
            Some(E::PhotosLightbox(event)) => {
                let Some(kind) = event.kind else {
                    return Vec::new();
                };
                match kind {
                    K::Refreshed(_) => return self.reload(ctx),
                    // A SWIPE IS A MOVE, NOT A ROUTE; the neighbours are KEPT.
                    K::Moved(moved) => {
                        if moved.photo_id != self.photo_id && !moved.photo_id.is_empty() {
                            return self.open(ctx, &moved.photo_id);
                        }
                    }
                    K::Chrome(toggled) => self.chrome_visible = toggled.visible,
                    K::Sheet(changed) => {
                        let sheet = Sheet::try_from(changed.sheet).unwrap_or(Sheet::None);
                        if sheet == Sheet::Place {
                            self.read_places(ctx);
                        }
                        self.sheet = if sheet == Sheet::Unspecified {
                            Sheet::None
                        } else {
                            sheet
                        };
                    }
                    K::Verb(tapped) => {
                        let kind = V::try_from(tapped.kind).unwrap_or(V::Unspecified);
                        // A refused verb is not run: its reason is already on screen.
                        let usable = self.verb_enabled(locale, kind);
                        if usable {
                            return self.tap(kind, ctx);
                        }
                    }
                    K::StatusActed(_) => {
                        if self.undo.acted(ctx) {
                            self.reload(ctx);
                        }
                    }
                    K::AlbumChoice(album) => self.album_event(&album, ctx),
                    K::People(link) => self.people_event(&link, ctx),
                    K::Link(link) => self.link_event(&link, ctx),
                    K::Attachment(attachment) => return self.attachments.event(ctx, attachment),
                    K::Share(chosen) => {
                        self.sheet = Sheet::None;
                        let precision =
                            Precision::try_from(chosen.precision).unwrap_or(Precision::None);
                        return self.export(
                            false,
                            if precision == Precision::Exact {
                                Precision::Exact
                            } else {
                                Precision::None
                            },
                            ctx,
                        );
                    }
                    K::FetchOriginal(_) => self.fetch(ctx),
                    K::Caption(typed) => {
                        // Trimmed, and a caption identical to the one on screen is
                        // not a write: a field that lost focus unchanged would
                        // otherwise commit the same words every time info closes.
                        let caption = typed.caption.trim().to_owned();
                        if let Some(detail) = self.detail()
                            && caption != detail.cell.title.trim()
                        {
                            let id = self.photo_id.clone();
                            let written = self.write(
                                ctx,
                                "retitle-photo",
                                &[&id, &caption],
                                act::photos::RetitlePhoto {
                                    photo_id: id.clone(),
                                    title: caption.clone(),
                                    expected_rev: self.rev,
                                },
                                Some(own::caption_changed(ctx.locale())),
                            );
                            // The photograph changed, or went to the trash, since it was read:
                            // the caption typed is kept as an earlier version and the page reads
                            // the photograph as it is now (#1185).
                            if !written && let Some(stale) = self.stale.take() {
                                let said = stale::on_button(
                                    ctx,
                                    &chat_confirm::noun_photo(ctx.locale()),
                                    &id,
                                    stale,
                                    vec![("entity.title".to_owned(), caption.into())],
                                );
                                self.reload(ctx);
                                self.undo.refuse(said);
                            }
                        }
                    }
                    K::TagAdded(added) => {
                        // AN EMPTY LABEL IS NOT A WRITE.
                        let label = added.label.trim().to_owned();
                        if !label.is_empty() {
                            let id = self.photo_id.clone();
                            self.write(
                                ctx,
                                "tag-photo",
                                &[&id, &label],
                                act::photos::TagPhoto {
                                    photo_id: id.clone(),
                                    label: label.clone(),
                                },
                                Some(own::label_added(ctx.locale())),
                            );
                        }
                    }
                    K::TagRemoved(removed) => {
                        // BY THE WORD THE LABEL CARRIES: the chip tapped says which.
                        let label = self
                            .detail()
                            .and_then(|d| d.tags.iter().find(|t| t.tag_id == removed.tag_id))
                            .map(|tag| tag.label.clone())
                            .unwrap_or_default();
                        if !label.is_empty() {
                            let id = self.photo_id.clone();
                            self.write(
                                ctx,
                                "untag-photo",
                                &[&id, &label],
                                act::photos::UntagPhoto {
                                    photo_id: id.clone(),
                                    label: label.clone(),
                                },
                                Some(own::label_removed(ctx.locale())),
                            );
                        }
                    }
                    K::PlaceChosen(chosen) => {
                        // AN EMPTY CHOICE CLEARS THE PLACE, by omitting the field.
                        self.sheet = Sheet::None;
                        let id = self.photo_id.clone();
                        let place = chosen.place_id;
                        self.write(
                            ctx,
                            "set-place",
                            &[&id, &place],
                            act::photos::SetPlace {
                                id: id.clone(),
                                place_id: if place.is_empty() {
                                    Field::Keep
                                } else {
                                    Field::Is(place.clone())
                                },
                            },
                            Some(own::place_changed(ctx.locale())),
                        );
                    }
                    K::CopyLocation(_) => {
                        let text = self
                            .detail()
                            .and_then(|d| d.place.as_ref())
                            .and_then(|card| card.exact_location.clone())
                            .unwrap_or_default();
                        if !text.is_empty() {
                            self.receipt(words::photos_location_copied(locale));
                            return vec![effect(wire::effect::Kind::ClipboardSet(
                                wire::ClipboardSet {
                                    text,
                                    sensitive: false,
                                    // A place is not a secret: the clip stays.
                                    clear_after_ms: 0,
                                },
                            ))];
                        }
                    }
                    K::SlideshowLeft(_) => {
                        self.slideshow = false;
                        ctx.cancel_timer(SLIDESHOW_TIMER);
                    }
                    K::Confirmed(_) => {
                        if self.confirm {
                            self.confirm = false;
                            let id = self.photo_id.clone();
                            if self.write(
                                ctx,
                                "purge-photo",
                                &[&id],
                                act::photos::PurgePhoto {
                                    photo_id: id.clone(),
                                },
                                None,
                            ) {
                                // Nothing left to show: the photograph is gone.
                                self.dismissed = true;
                            }
                        }
                    }
                    K::ConfirmDismissed(_) => self.confirm = false,
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let photo = self
            .content
            .data()
            .map(|detail| self.photo(detail, locale, ctx.units(), ctx.hour_cycle()));
        let refusal = self.refusal(locale);
        let edit = self
            .detail()
            .map(|d| editor::edit_refusal(locale, Some(&d.cell), self.fetching))
            .unwrap_or_else(|| editor::edit_refusal(locale, None, false));
        let (toolbar, menu) = verbs(
            locale,
            self.detail(),
            refusal.as_deref(),
            edit.as_deref(),
            &self.photo_id,
            &self.album_id,
            Offers {
                slideshow: self.neighbours.len() > 1,
                info_open: self.sheet == Sheet::Info,
            },
        );
        let at = self.position();
        let neighbour = |index: Option<usize>| {
            index
                .and_then(|i| self.neighbours.get(i))
                .cloned()
                .unwrap_or_default()
        };
        let window = film_window(&self.neighbours, &self.photo_id);
        let first = window
            .first()
            .and_then(|id| self.neighbours.iter().position(|n| n == id))
            .unwrap_or(0);
        let located_precisely = self.detail().is_some_and(|d| {
            d.place
                .as_ref()
                .is_some_and(|card| card.exact_location.is_some())
        });
        let state = wire::PhotosLightboxState {
            photo_id: self.photo_id.clone(),
            page: Some(self.content.wire(
                locale,
                |denial| super::denied(locale, denial),
                wire::EmptyState::default,
            )),
            content: photo
                .map(|photo| wire::photos_lightbox_state::Content::Photo(Box::new(photo))),
            chrome_visible: self.chrome_visible || self.slideshow,
            sheet: self.sheet as i32,
            slideshow: self.slideshow,
            slideshow_meta: at.map_or_else(String::new, |at| {
                fill(
                    &words::photos_slideshow_meta(locale),
                    &[
                        ("position", &(at + 1).to_string()),
                        ("total", &self.neighbours.len().to_string()),
                        ("seconds", &SLIDESHOW_INTERVAL.as_secs().to_string()),
                    ],
                )
            }),
            slideshow_line: words::photos_slideshow_line(locale),
            status: self
                .undo
                .status()
                .or_else(|| self.earlier.status(locale))
                .or_else(|| {
                    self.linked_unread.then(|| wire::StatusLine {
                        sentence: own::links_unread(locale),
                        action_label: String::new(),
                        refused: false,
                    })
                }),
            album_choice: Some(self.albums.view(locale, Link::default())),
            people_picker: Some(self.links.picker(locale, &self.people_ids())),
            link_picker: (self.linked.is_some() && self.every.is_open())
                .then(|| self.every.picker(locale, &self.linked_ids())),
            place_choices: self.place_choices(locale),
            confirm: self.confirm.then(|| wire::Confirm {
                title: words::photos_delete_forever_one(locale),
                body: words::photos_delete_forever_body(locale),
                confirm_label: shared::trash_purge(locale),
                destructive: true,
            }),
            dismissed: self.dismissed,
            film: window
                .iter()
                .enumerate()
                .map(|(index, id)| wire::PhotosLightboxFrame {
                    accessibility_label: fill(
                        &words::photos_filmstrip_show(locale),
                        &[
                            ("number", &(first + index + 1).to_string()),
                            ("total", &self.neighbours.len().to_string()),
                        ],
                    ),
                    photo_id: id.clone(),
                    tile: if *id == self.photo_id {
                        self.detail().map(|d| self.tile(&d.cell, locale))
                    } else {
                        self.film
                            .get(id)
                            .map(|cell| cells::tile(cell, Link::default(), locale))
                    },
                    current: *id == self.photo_id,
                })
                .collect(),
            previous_id: neighbour(at.and_then(|at| at.checked_sub(1))),
            next_id: neighbour(at.map(|at| at + 1)),
            position: at.map_or_else(String::new, |at| {
                format!("{} of {}", at + 1, self.neighbours.len())
            }),
            toolbar,
            menu,
            share_choices: vec![
                wire::PhotosLightboxShareChoice {
                    precision: Precision::None as i32,
                    label: words::photos_send_no_location(locale),
                    detail: words::photos_send_none_detail(locale),
                },
                wire::PhotosLightboxShareChoice {
                    precision: Precision::Exact as i32,
                    label: words::photos_send_exact_location(locale),
                    detail: if located_precisely {
                        words::photos_send_exact_detail_located(locale)
                    } else {
                        words::photos_send_exact_detail_unlocated(locale)
                    },
                },
            ],
            words: Some(Self::words(locale)),
        };
        wire::ViewState {
            instance: 0,
            revision: 0,
            kind: Some(wire::view_state::Kind::PhotosLightbox(Box::new(state))),
        }
    }
}

impl Lightbox {
    /// Is the verb live now? The same table the view draws, so a disabled control
    /// and the gate cannot disagree.
    fn verb_enabled(&self, locale: Locale, kind: V) -> bool {
        let refusal = self.refusal(locale);
        let edit = self
            .detail()
            .map(|d| editor::edit_refusal(locale, Some(&d.cell), self.fetching))
            .unwrap_or_else(|| editor::edit_refusal(locale, None, false));
        let (toolbar, menu) = verbs(
            locale,
            self.detail(),
            refusal.as_deref(),
            edit.as_deref(),
            &self.photo_id,
            &self.album_id,
            Offers {
                slideshow: self.neighbours.len() > 1,
                info_open: self.sheet == Sheet::Info,
            },
        );
        toolbar
            .iter()
            .chain(menu.iter())
            .find(|verb| verb.kind == kind as i32)
            .is_some_and(|verb| verb.enabled)
    }

    /// By name, because a member finds a place by reading it; "No place" first.
    fn place_choices(&self, locale: Locale) -> Vec<wire::PhotosLightboxPlaceChoice> {
        if self.sheet != Sheet::Place {
            return Vec::new();
        }
        let here = self
            .detail()
            .and_then(|d| d.cell.place_id.clone())
            .unwrap_or_default();
        let mut choices: Vec<wire::PhotosLightboxPlaceChoice> = self
            .places
            .iter()
            .filter_map(|card| {
                let place = card.place.as_ref()?;
                let name = card
                    .name
                    .clone()
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| card.phrase.clone());
                Some(wire::PhotosLightboxPlaceChoice {
                    here: place.place_id == here,
                    place_id: place.place_id.clone(),
                    name,
                })
            })
            .collect();
        choices.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.place_id.cmp(&b.place_id))
        });
        choices.insert(
            0,
            wire::PhotosLightboxPlaceChoice {
                place_id: String::new(),
                name: words::photos_place_none(locale),
                here: here.is_empty(),
            },
        );
        choices
    }
}
