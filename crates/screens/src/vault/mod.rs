//! THE VAULTS THIS PHONE HOLDS (#1135, wave 4, lane H2): the shelf that opens,
//! rests, wakes, freezes and forgets them, the launch that opens them keyed,
//! and the foreground every screen reads through. Ported from the Kotlin
//! `Shelf`, `HomeSession` and `VaultRoster`; the shell hands the core a
//! directory and draws what `shell.holdings` says.
//!
//! ## THE FOREGROUND VAULT
//!
//! Screens read through whichever core is in front, and they do it with no
//! change of their own: the core the shell opened is the *front* and sends
//! every request that is about a vault to the vault in front
//! (`centraid_core::vaults`). Switching is the runtime's:
//!
//! * a screen asks (`Ctx::switch_vault`), the runtime sends every open screen
//!   its last event so what the member typed is written to the vault it was
//!   typed in, brings the other vault to the front, and closes and reopens each
//!   tab's root, so no screen shows one vault's rows over another's;
//! * a foreground that changes any other way (a vault founded, the one in front
//!   forgotten, the first vault of a launch) closes and reopens the roots
//!   without the last event — the vault they would write to is gone or is not
//!   the one they were typed in.
//!
//! Both are an ordinary `ScreenUpdate` (instances closed, new views, a new
//! navigation); the shell draws them like any other. What Home draws beside
//! them is `shell.holdings`, which re-renders whoever read it (the table
//! `shelf`) on every change.

pub mod files;
pub mod service;
pub mod shelf;
pub mod types;

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

pub use shelf::{DEV_INDEX, Moved, Prepare, Shelf, default_prepare};
pub use types::{Effected, Foreground, Found, FoundRefusal, Restored};

/// Every screen of the shelf, registered under its route name.
#[must_use]
pub fn registry(shelf: &Arc<Shelf>, secrets: &VaultSecrets) -> Registry {
    service::registry(shelf, secrets)
}

/// The shelf's services: see [`crate::Runtime::with_services`].
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![service::route()]
}
