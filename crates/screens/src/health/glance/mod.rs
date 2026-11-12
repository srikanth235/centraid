//! HEALTH'S GLANCE (#1185): what the Health widget draws, decided in Rust, kept current the way
//! Agenda's is (`kit::glance`).
//!
//! | Piece | What it decides |
//! |---|---|
//! | [`snapshot`] | the widget's JSON document: today's figures, worded in the member's units |
//! | [`service`] | the view-less screen that keeps the document current and opens Health on a tap |
//!
//! ## What the shell does
//!
//! It performs one effect (`HealthGlance`: write the document atomically to the shared container
//! under the file name the effect carries, then reload the Health widgets) and reports one fact
//! (`ShellFact.health_intent`: the widget was tapped). It reads the document to draw it and
//! compares two civil strings against `refresh_after`; it decides nothing else, and the widget
//! never opens the vault.
//!
//! The static names the platform needs at compile time (the gallery name and description) are
//! generated from `strings/health_glance.rs` by `cargo xtask design`.

pub mod service;
pub mod snapshot;

#[cfg(test)]
mod tests;

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub use service::NAME;

/// The services Health runs for as long as the runtime does: see [`crate::Runtime::with_services`].
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![service::route()]
}

/// The glance service, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default().with(NAME, service::build)
}
