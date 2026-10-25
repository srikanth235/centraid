//! The screen runtime (#1135, lane C2): every decision a person sees is made in
//! Rust. Screen state, finished strings, counts, navigation and timers live
//! here; SwiftUI and Compose draw `ViewState`, send `ScreenEvent`s and perform
//! `Effect`s (`screens.proto`). `docs/screens.md` is
//! the contract and the porting recipe.

pub mod agenda;
pub mod catalog;
pub mod docs;
pub mod field;
pub mod kit;
pub mod locker;
pub mod money;
pub mod notes;
pub mod photos;
pub mod proof;
pub mod registry;
pub mod runtime;
pub mod screen;
pub mod strings;
pub mod testing;

pub use registry::Registry;
pub use runtime::Runtime;
pub use screen::{Ctx, Environment, Screen};

/// The runtime the shells attach today: the proof screen on one tab and
/// Agenda's screens on another. The shell lane replaces the roots with the
/// real ones as it ports Home and the other apps.
#[must_use]
pub fn standard() -> Runtime {
    Runtime::new(
        Registry::default()
            .with(proof::NAME, proof::build)
            .merge(agenda::registry())
            .merge(locker::registry())
            .merge(money::registry())
            .merge(docs::registry())
            .merge(notes::registry())
            .merge(photos::registry()),
        vec![
            ("proof".to_owned(), proof::route()),
            (
                agenda::TAB.to_owned(),
                agenda::routes::home(centraid_api_proto::core_v1::AgendaDestination::Day, ""),
            ),
            (
                photos::TAB.to_owned(),
                photos::routes::home(
                    centraid_api_proto::core_v1::PhotosDestination::Library,
                    None,
                ),
            ),
        ],
    )
}

/// Attach [`standard`] to a core. `centraid_open` calls this.
pub fn attach(handle: &centraid_core::Handle) {
    handle.attach_screens(std::sync::Arc::new(standard()));
}
