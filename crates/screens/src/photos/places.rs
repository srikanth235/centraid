//! `photos.places` (Every place, as cards or a map.) — a SKELETON for worker 2 of lane D (#1135).
//!
//! Replace this file: keep `build(route)` and the `Screen` it returns, and fill
//! `PhotosPlacesState` / `PhotosPlacesEvent` in the lane's proto file. The shared pieces
//! are `cells`, `selection` and `album_choice`.

use centraid_api_proto::core_v1 as wire;

use crate::screen::{Ctx, Screen};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Skeleton))
}

struct Skeleton;

impl Screen for Skeleton {
    fn update(&mut self, _event: wire::ScreenEvent, _ctx: &Ctx) -> Vec<wire::Effect> {
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            instance: 0,
            revision: 0,
            kind: Some(wire::view_state::Kind::PhotosPlaces(
                wire::PhotosPlacesState {},
            )),
        }
    }
}
