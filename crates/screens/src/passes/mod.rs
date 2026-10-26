//! THE PASS (#1135, wave 4, lane H2): when a backup pass runs, under which rule
//! and on which link, and what the member is told about it. The pass itself is
//! the core's `drain`; the shell performs the calls and schedules the operating
//! system's windows, and everything that is decided is here.
//!
//! | Piece | What it decides |
//! |---|---|
//! | [`conductor`] | the trigger table, debounces, rounds, the divided deadline, the iOS hand-off order; the facts the Backup screen draws |
//! | [`service`] | the view-less screen that hears the app and performs the conductor's actions |
//! | [`rule`] | the member's transfer rule and "Include videos", and the rule's sentences |
//! | [`conditions`] | why a pass runs, and the one place an unknown link becomes the expensive answer |
//! | [`windows`] | which background windows the shell keeps scheduled |
//!
//! ## What the shell does
//!
//! It reports facts (`ShellFact`: the link at launch and on every change, a
//! window the OS granted, the vaults held, a finished import or restore, an
//! upload the OS finished) and performs generic effects (`ScheduleWindows`,
//! `PassWindowDone`, `LongRun`, `UploadsOp` and
//! the off-thread door). It decides nothing; the camera roll's walk and the
//! bytes the core asks for again are posted to `imports.camera_roll` in Rust.

pub mod conditions;
pub mod conductor;
pub mod rule;
pub mod service;
pub mod windows;

#[cfg(test)]
mod tests;

pub use conditions::{Conditions, Link, Reason};
pub use conductor::{Action, Conductor, Facts, Held, Holdings, Registration};
pub use rule::{Rules, TransferRule};

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

/// The screens that run as long as the runtime does, with no view: see
/// [`crate::Runtime::with_services`].
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![service::route()]
}

/// Every pass screen and service, registered under its route name.
#[must_use]
pub fn registry(secrets: &VaultSecrets) -> Registry {
    Registry::default().with(service::NAME, service::build(secrets))
}
