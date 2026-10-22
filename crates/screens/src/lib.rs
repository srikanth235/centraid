//! The screen runtime (#1135, lane C2): every decision a person sees is made in
//! Rust. Screen state, finished strings, counts, navigation and timers live
//! here; SwiftUI and Compose draw `ViewState`, send `ScreenEvent`s and perform
//! `Effect`s (`screens.proto`). `docs/screens.md` is
//! the contract and the porting recipe.

pub mod proof;
pub mod registry;
pub mod runtime;
pub mod screen;
pub mod strings;
pub mod testing;


pub use registry::Registry;
pub use runtime::Runtime;
pub use screen::{Ctx, Environment, Screen};

/// The runtime the shells attach today: the proof screen on one tab. The shell
/// lane replaces the registry and the roots with the real ones.
#[must_use]
pub fn standard() -> Runtime {
    Runtime::new(
        Registry::default().with(proof::NAME, proof::build),
        vec![("proof".to_owned(), proof::route())],
    )
}

/// Attach [`standard`] to a core. `centraid_open` calls this.
pub fn attach(handle: &centraid_core::Handle) {
    handle.attach_screens(std::sync::Arc::new(standard()));
}
