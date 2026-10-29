//! THE PHONE IMPORTS (#1135, lane I): headless screens, the roots of three hidden tabs
//! ([`roots`]), opened again for each vault in front and never drawn. Every decision is Rust's;
//! the shell performs the platform work as generic effects and answers them, and sends two
//! things: `LibraryChanged` to the camera roll on an OS library change, and `Made` to the made
//! vault's screen when a vault is made. Everything else reaches them by name (`Ctx::post`).
//!
//! | Screen | Replaces (KMP) | Hosts |
//! |---|---|---|
//! | [`CAMERA_ROLL`] | `CameraRoll`, `CameraRollRunner`, `CameraRollSeat`, `LibraryFeed` | the walk, the grant, the cursor, the bytes asked for again |
//! | [`FILES`] | `PhoneFollow`, `FollowGate`, `FilesFollow`, `FilesImport`, `DocsFollowBridge` | a followed folder |
//! | [`MADE`] | `PhoneImport.made*` | what a made vault brings in, as one line |
//!
//! Dropped with the Kotlin architecture: `PhoneFollowSource`/`PhoneFollowPass` (one seam for
//! sources that no longer exist: contacts and calendar follow in `people`/`agenda`), the
//! held-origin question (`PhoneFollowQuestion`, `PhoneFollowWords`, `OriginGone`: the vault's
//! `follow.*` decides what a file gone from a complete read does, so nothing is held for a
//! question), `PhoneDevice` (the shell mints the install id and sends it with every listing),
//! `PhonePages` (the vault's own `files-followed` read), `Staging` and `StageFileBridge` (the stage
//! door is the shell's, streaming; the record names the bytes and their size and `follow-files`
//! claims them), and `PhoneImport`'s
//! `write`/`executed`/`quote` (`act` with generated ids).

pub mod camera_roll;
pub mod files;
pub mod gate;
pub mod made;
pub mod reminders;

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

pub const CAMERA_ROLL: &str = "imports.camera_roll";
pub const FILES: &str = "imports.files";
pub const MADE: &str = "imports.made";

/// The registry of the three services, over the phone's secrets (the member's transfer rule).
#[must_use]
pub fn registry(secrets: &VaultSecrets) -> Registry {
    Registry::default()
        .with(CAMERA_ROLL, camera_roll::build(secrets))
        .with(FILES, files::build)
        .with(MADE, made::build)
}

/// The routes of the services, one per vault.
pub mod routes {
    use super::{CAMERA_ROLL, FILES, MADE, wire};

    fn route(screen: &str, vault_id: &str) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(wire::route::Args::Imports(wire::ImportsRoute {
                vault_id: vault_id.to_owned(),
            })),
        }
    }

    #[must_use]
    pub fn camera_roll(vault_id: &str) -> wire::Route {
        route(CAMERA_ROLL, vault_id)
    }

    #[must_use]
    pub fn files(vault_id: &str) -> wire::Route {
        route(FILES, vault_id)
    }

    #[must_use]
    pub fn made(vault_id: &str) -> wire::Route {
        route(MADE, vault_id)
    }
}

/// The three services as hidden tab roots: `(tab, route)`, in the order the shell opens them. A
/// service is a screen that is never drawn, and the runtime opens instances only as a tab's root or
/// a push, so the navigation root (lane H1) appends these to its tabs and keeps them out of the tab
/// bar. They serve the runtime's own vault (a core is one vault; a vault switch is a new runtime),
/// so the route's `vault_id` is empty here and the camera roll learns its vault id from the
/// events that carry it.
#[must_use]
pub fn roots() -> Vec<(String, wire::Route)> {
    vec![
        ("imports-camera-roll".to_owned(), routes::camera_roll("")),
        ("imports-files".to_owned(), routes::files("")),
        ("imports-made".to_owned(), routes::made("")),
    ]
}

/// A runtime that hosts only the three services, for tests.
#[must_use]
pub fn runtime() -> crate::Runtime {
    runtime_with(&VaultSecrets::new())
}

/// [`runtime`], over secrets a test fills (the member's transfer rule).
#[must_use]
pub fn runtime_with(secrets: &VaultSecrets) -> crate::Runtime {
    crate::Runtime::new(registry(secrets), roots())
}

pub(crate) fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

/// Whitespace runs (and no-break spaces) become one space; the ends go.
#[must_use]
pub fn squash(value: &str) -> String {
    value
        .split(|c: char| c.is_whitespace() || c == '\u{a0}')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
