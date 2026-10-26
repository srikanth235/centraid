//! "ADD TO ALBUM", ONCE, FOR EVERY SCREEN THAT OFFERS IT (#1135): the lightbox,
//! the library grid and a shelf each hold an [`AlbumChoice`] beside their
//! [`super::selection::Selection`] and hand it their sheet events.
//!
//! ## How a host screen uses it
//!
//! 1. [`AlbumChoiceEvent::Opened`] over a pick opens the sheet and reads the
//!    albums (`photos.albums`: every album with its exact count and its cover).
//! 2. [`Chosen`](wire::photos_album_choice_event::Chosen) closes the sheet and
//!    adds every picked photograph to the album, one `act` each, keyed on the
//!    album and the photograph. A photograph already in the album is a no-op (an
//!    edge is idempotent); a refused one carries the vault's own sentence and the
//!    others land.
//! 3. [`Created`](wire::photos_album_choice_event::Created) makes the album and
//!    KEEPS THE SHEET OPEN: the list reads again with the new album in it, and the
//!    member's next tap puts the pick there. An empty name is not a write.
//! 4. A change to the albums or their members re-reads the list while the sheet
//!    is open ([`AlbumChoice::reload`] on `DataChanged`).
//!
//! A refused list arrives EMPTY: the sheet's "New album…" row is still there, and
//! a sheet that hung over a refusal would be one the member cannot leave by doing
//! anything useful.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_album_choice_event::Kind as E;

use super::cells::{self, Link};
use super::selection::{Written, each};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{Locale, photos as words};

/// What a sheet event came to, for the screen to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Only the sheet moved.
    Moved,
    /// The pick went into `album_id`; the screen settles its selection with the
    /// result.
    Added { album_id: String, written: Written },
    /// A create ran. The sheet stays open; `refusal` is the vault's sentence when
    /// it was refused.
    Created { refusal: Option<String> },
}

/// The sheet: whether it is up, and the albums it lists.
#[derive(Clone, Debug, Default)]
pub struct AlbumChoice {
    open: bool,
    loaded: bool,
    albums: Vec<wire::PhotosAlbumCard>,
    /// An album the list leaves out: a shelf does not offer its own album, because
    /// adding an album's photographs to itself is a batch of refusals.
    exclude: Option<String>,
}

impl AlbumChoice {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// This sheet never lists `album_id`.
    #[must_use]
    pub fn excluding(album_id: &str) -> Self {
        Self {
            exclude: Some(album_id.to_owned()).filter(|id| !id.is_empty()),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn open(&self) -> bool {
        self.open
    }

    /// Close the sheet (the mode it served ended).
    pub fn close(&mut self) {
        self.open = false;
    }

    /// Read the albums. A refusal is an empty, loaded list.
    pub fn load(&mut self, ctx: &Ctx) {
        let reading = read::read(
            ctx,
            load::photos::Albums::default(),
            |answer| match answer {
                Answer::PhotosAlbums(albums) => Some(albums),
                _ => None,
            },
        );
        self.albums = match reading {
            Reading::Data(albums) => albums
                .albums
                .into_iter()
                .filter(|album| self.exclude.as_deref() != Some(album.album_id.as_str()))
                .collect(),
            Reading::Denied(_) | Reading::Failed => Vec::new(),
        };
        self.loaded = true;
    }

    /// The albums or their members moved: read the list again if it is on screen.
    pub fn reload(&mut self, ctx: &Ctx) {
        if self.open {
            self.load(ctx);
        }
    }

    /// Take one sheet event. `picked` is the photographs the pick holds: the
    /// sheet opens over a pick and never over nothing, because a list of albums
    /// with no photograph to put in one is a sheet with no verb.
    pub fn update(
        &mut self,
        event: &wire::PhotosAlbumChoiceEvent,
        picked: &[String],
        ctx: &Ctx,
    ) -> Outcome {
        match &event.kind {
            Some(E::Opened(_)) => {
                if !picked.is_empty() {
                    self.open = true;
                    self.load(ctx);
                }
                Outcome::Moved
            }
            Some(E::Dismissed(_)) => {
                self.open = false;
                Outcome::Moved
            }
            Some(E::Chosen(chosen)) => {
                self.open = false;
                Outcome::Added {
                    album_id: chosen.album_id.clone(),
                    written: add(ctx, picked, &chosen.album_id),
                }
            }
            Some(E::Created(created)) => {
                let refusal = create(ctx, &created.title);
                self.load(ctx);
                Outcome::Created { refusal }
            }
            None => Outcome::Moved,
        }
    }

    /// The sheet, finished.
    #[must_use]
    pub fn view(&self, locale: Locale, link: Link) -> wire::PhotosAlbumChoice {
        let entries: Vec<wire::PhotosAlbumChoiceEntry> = self
            .albums
            .iter()
            .map(|album| wire::PhotosAlbumChoiceEntry {
                album_id: album.album_id.clone(),
                title: album.title.clone(),
                count: album.count,
                count_label: cells::count_phrase(locale, album.count, false),
                cover: album
                    .cover
                    .as_ref()
                    .map(|cover| cells::tile(cover, link, locale)),
            })
            .collect();
        wire::PhotosAlbumChoice {
            open: self.open,
            title: words::photos_add_to_album(locale),
            loaded: self.loaded,
            empty: if self.loaded && entries.is_empty() {
                words::photos_album_choice_none(locale)
            } else {
                String::new()
            },
            entries,
            new_album_label: words::photos_album_choice_new(locale),
            name_placeholder: words::photos_album_name(locale),
            create_label: words::photos_create(locale),
            cancel_label: words::photos_cancel(locale),
        }
    }
}

/// Put every photograph into the album: one `edge.add` each, which places it
/// after the photographs the album has. An empty album id is not a write.
pub fn add(ctx: &Ctx, photo_ids: &[String], album_id: &str) -> Written {
    if album_id.is_empty() {
        return Written::default();
    }
    let mut ids: Vec<String> = Vec::new();
    for id in photo_ids {
        if !id.is_empty() && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    each(ctx, &ids, "add-to-album", |id| {
        act::photos::AddToAlbum {
            from: album_id.to_owned(),
            to: id.to_owned(),
            ..Default::default()
        }
        .into()
    })
}

/// Make an album called `title` (trimmed). An empty name is not a write: the
/// vault's `title` is `minLength: 1`. Returns the vault's refusal, if any.
pub fn create(ctx: &Ctx, title: &str) -> Option<String> {
    match create_album(ctx, title) {
        Err(sentence) if !sentence.is_empty() => Some(sentence),
        _ => None,
    }
}

/// [`create`], answering the id the vault minted.
///
/// # Errors
/// The vault's sentence when the create was refused; an empty name is an empty
/// sentence, which is no write.
pub fn create_album(ctx: &Ctx, title: &str) -> Result<String, String> {
    let name = title.trim();
    if name.is_empty() {
        return Err(String::new());
    }
    let key = kit_act::key(&["create-album", name], kit_act::fresh());
    let settled = kit_act::act(
        ctx,
        act::photos::CreateAlbum {
            title: name.to_owned(),
            id: None,
        },
        &key,
    );
    if settled.committed {
        Ok(settled.output_text("id").unwrap_or_default())
    } else {
        Err(settled.refusal)
    }
}
