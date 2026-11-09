//! AGENDA'S GLANCE (#1173, wave 3): what a widget draws and what Siri or a
//! shortcut can ask, decided in Rust.
//!
//! | Piece | What it decides |
//! |---|---|
//! | [`snapshot`] | the widgets' JSON document: rows, labels, counts, Siri's sentence |
//! | [`service`] | the view-less screen that keeps the document current and answers the platform's asks |
//!
//! ## What the shell does
//!
//! It performs one effect (`AgendaGlance`: write the document atomically to the
//! shared container, then reload the widgets) and reports one fact
//! (`ShellFact.agenda_intent`: the platform asked Agenda to add a reminder). It
//! reads the document to draw it and compares two civil strings against
//! `refresh_after`; it decides nothing else.
//!
//! The static names the platform needs at compile time (gallery names, intent
//! titles, Siri phrases, shortcut labels) are generated from
//! `strings/agenda_glance.rs` by `cargo xtask design`.

pub mod service;
pub mod snapshot;

#[cfg(test)]
mod tests;

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub use service::NAME;

/// The services Agenda runs for as long as the runtime does: see
/// [`crate::Runtime::with_services`].
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![service::route()]
}

/// The glance service, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default().with(NAME, service::build)
}
