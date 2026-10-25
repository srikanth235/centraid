//! PHOTOS' SCREENS (#1135, lane D): the library, its shelves and the one
//! photograph. Every decision a person sees is made here; SwiftUI and Compose
//! draw [`wire::ViewState`].
//!
//! | Screen | Route name | Module |
//! |---|---|---|
//! | Library · Collections · Search, with More | [`HOME`] | [`home`] |
//! | A shelf: favourites, videos, archive, trash, an album, a place | [`SHELF`] | [`shelf`] |
//! | Adding photographs to an album | [`PICKER`] | [`picker`] |
//! | Places | [`PLACES`] | [`places`] |
//! | One photograph | [`LIGHTBOX`] | [`lightbox`] |
//! | Crop, rotate, straighten | [`EDITOR`] | [`editor`] |
//! | Near-duplicate sets | [`DUPLICATES`] | [`duplicates`] |
//! | One set, and the keep decision | [`DUPLICATE_REVIEW`] | [`duplicate_review`] |
//!
//! ## What the screens share
//!
//! - [`cells`]: the core's [`wire::PhotosCell`] as the [`wire::PhotoTile`] a grid
//!   draws (what this device holds, the capture-local day, a Live Photo folded
//!   into one cell, the count phrase).
//! - [`selection`]: select mode, the picked set, the bar, the confirm and the
//!   batch writes.
//! - [`album_choice`]: the "Add to album" sheet.
//!
//! A row that opens a page carries the [`wire::Route`] to push (built by
//! [`routes`]), so a shell never names a screen.
//!
//! ## Where this lives
//!
//! Not in `crates/apps/photos`: the core depends on that crate for its readers
//! and this crate depends on the core for `load` and `act`, so a screen there
//! would make a cycle.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub mod album_choice;
pub mod cells;
pub mod duplicate_review;
pub mod duplicates;
pub mod editor;
pub mod fetch;
pub mod home;
pub mod keep_originals;
pub mod lightbox;
pub mod media;
pub mod picker;
pub mod places;
pub mod selection;
pub mod shelf;

pub const HOME: &str = "photos.home";
pub const SHELF: &str = "photos.shelf";
pub const PICKER: &str = "photos.picker";
pub const PLACES: &str = "photos.places";
pub const LIGHTBOX: &str = "photos.lightbox";
pub const EDITOR: &str = "photos.editor";
pub const DUPLICATES: &str = "photos.duplicates";
pub const DUPLICATE_REVIEW: &str = "photos.duplicate_review";

/// The tab Photos' home is the root of.
pub const TAB: &str = "photos";

/// Every Photos screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(SHELF, shelf::build)
        .with(PICKER, picker::build)
        .with(PLACES, places::build)
        .with(LIGHTBOX, lightbox::build)
        .with(EDITOR, editor::build)
        .with(DUPLICATES, duplicates::build)
        .with(DUPLICATE_REVIEW, duplicate_review::build)
}

/// A runtime with Photos' screens and one tab, `photos`, rooted at its home. The
/// shell's real runtime composes [`registry`] with the other apps'; this is what
/// Photos' own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            routes::home(wire::PhotosDestination::Library, None),
        )],
    )
}

/// The routes Photos' own screens hand to a shell inside a view state.
pub mod routes {
    use super::{
        DUPLICATE_REVIEW, DUPLICATES, EDITOR, HOME, LIGHTBOX, PICKER, PLACES, SHELF, wire,
    };

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// Photos' home, landing on `destination`; `query` opens Search on those words.
    #[must_use]
    pub fn home(destination: wire::PhotosDestination, query: Option<&str>) -> wire::Route {
        route(
            HOME,
            wire::route::Args::PhotosHome(wire::PhotosHomeRoute {
                destination: destination as i32,
                query: query.map(str::to_owned),
            }),
        )
    }

    /// One shelf. `id` names the album or the place (empty for the others);
    /// `title` rides along so the head has words before the read lands.
    #[must_use]
    pub fn shelf(kind: wire::PhotosShelfKind, id: &str, title: &str) -> wire::Route {
        route(
            SHELF,
            wire::route::Args::PhotosShelf(wire::PhotosShelfRoute {
                kind: kind as i32,
                id: id.to_owned(),
                title: title.to_owned(),
            }),
        )
    }

    /// The picker that adds photographs to the album `album_id`.
    #[must_use]
    pub fn picker(album_id: &str, album_name: &str) -> wire::Route {
        route(
            PICKER,
            wire::route::Args::PhotosPicker(wire::PhotosPickerRoute {
                purpose: wire::PhotosPickerPurpose::AddToAlbum as i32,
                album_id: album_id.to_owned(),
                album_name: album_name.to_owned(),
            }),
        )
    }

    /// The picker that chooses ONE photograph for the chat to attach; the pick goes back to
    /// `chat.home` as an `Attached` event.
    #[must_use]
    pub fn attach_picker() -> wire::Route {
        route(
            PICKER,
            wire::route::Args::PhotosPicker(wire::PhotosPickerRoute {
                purpose: wire::PhotosPickerPurpose::Attach as i32,
                album_id: String::new(),
                album_name: String::new(),
            }),
        )
    }

    #[must_use]
    pub fn places() -> wire::Route {
        route(
            PLACES,
            wire::route::Args::PhotosPlaces(wire::PhotosPlacesRoute {}),
        )
    }

    /// One photograph. `neighbour_ids` are the ids a swipe walks, in the order the
    /// opening surface drew them; `album_id` is the album it was opened from.
    #[must_use]
    pub fn lightbox(photo_id: &str, neighbour_ids: &[String], album_id: &str) -> wire::Route {
        route(
            LIGHTBOX,
            wire::route::Args::PhotosLightbox(wire::PhotosLightboxRoute {
                photo_id: photo_id.to_owned(),
                neighbour_ids: neighbour_ids.to_vec(),
                album_id: album_id.to_owned(),
            }),
        )
    }

    #[must_use]
    pub fn editor(photo_id: &str) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::PhotosEditor(wire::PhotosEditorRoute {
                photo_id: photo_id.to_owned(),
            }),
        )
    }

    #[must_use]
    pub fn duplicates() -> wire::Route {
        route(
            DUPLICATES,
            wire::route::Args::PhotosDuplicates(wire::PhotosDuplicatesRoute {}),
        )
    }

    /// One duplicate set, by the cluster's key.
    #[must_use]
    pub fn duplicate_review(cluster_key: &str) -> wire::Route {
        route(
            DUPLICATE_REVIEW,
            wire::route::Args::PhotosDuplicateReview(wire::PhotosDuplicateReviewRoute {
                cluster_key: cluster_key.to_owned(),
            }),
        )
    }
}
