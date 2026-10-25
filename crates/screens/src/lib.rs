//! The screen runtime (#1135, lane C2): every decision a person sees is made in
//! Rust. Screen state, finished strings, counts, navigation and timers live
//! here; SwiftUI and Compose draw `ViewState`, send `ScreenEvent`s and perform
//! `Effect`s (`screens.proto`). `docs/screens.md` is
//! the contract and the porting recipe.

pub mod agenda;
pub mod catalog;
pub mod docs;
pub mod field;
pub mod health;
pub mod kit;
pub mod locker;
pub mod money;
pub mod notes;
pub mod people;
pub mod photos;
pub mod proof;
pub mod registry;
pub mod runtime;
pub mod screen;
pub mod shell;
pub mod strings;
pub mod testing;

pub use registry::Registry;
pub use runtime::Runtime;
pub use screen::{Ctx, Environment, Screen};

/// The runtime the shells attach: every app's screens and the shell's own, and
/// one tab, `home`, rooted at Home (`shell`). An app opens as a page pushed on
/// that tab, so back returns to Home; the chat and the backup add their own tabs
/// beside it. The band follows the tabs that exist.
#[must_use]
pub fn standard() -> Runtime {
    Runtime::new(
        Registry::default()
            .with(proof::NAME, proof::build)
            .merge(shell::registry())
            .merge(agenda::registry())
            .merge(locker::registry())
            .merge(money::registry())
            .merge(docs::registry())
            .merge(health::registry())
            .merge(notes::registry())
            .merge(people::registry())
            .merge(photos::registry()),
        vec![(shell::TAB.to_owned(), shell::routes::home())],
    )
    .with_band(shell::band::view)
}

/// Attach [`standard`] to a core. `centraid_open` calls this.
pub fn attach(handle: &centraid_core::Handle) {
    handle.attach_screens(std::sync::Arc::new(standard()));
}
