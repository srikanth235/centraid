//! The screen runtime (#1135, lane C2): every decision a person sees is made in
//! Rust. Screen state, finished strings, counts, navigation and timers live
//! here; SwiftUI and Compose draw `ViewState`, send `ScreenEvent`s and perform
//! `Effect`s (`screens.proto`). `docs/screens.md` is
//! the contract and the porting recipe.

pub mod agenda;
pub mod backup;
pub mod catalog;
pub mod custody;
pub mod docs;
pub mod field;
pub mod health;
pub mod kit;
pub mod locker;
pub mod money;
pub mod notes;
pub mod pairing;
pub mod passes;
pub mod people;
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
    // The vault plumbing's one cache of what the shell keeps secret: custody,
    // pairing, the backup screen and the pass service all read the same one.
    let secrets = custody::secrets::VaultSecrets::new();
    Runtime::new(
        Registry::default()
            .with(proof::NAME, proof::build)
            .merge(agenda::registry())
            .merge(locker::registry())
            .merge(money::registry())
            .merge(docs::registry())
            .merge(health::registry())
            .merge(notes::registry())
            .merge(people::registry())
            .merge(photos::registry())
            .merge(custody::registry(&secrets))
            .merge(pairing::registry(&secrets))
            .merge(backup::registry(&secrets))
            .merge(passes::registry(&secrets)),
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
    .with_services(passes::services())
}

/// Attach [`standard`] to a core. `centraid_open` calls this.
pub fn attach(handle: &centraid_core::Handle) {
    handle.attach_screens(std::sync::Arc::new(standard()));
}
