//! THE SHELL'S OWN CATALOGUE (#1135): the reads that are no one app's.
//!
//! The eight apps each carry a `manifest.json` that names their actions and
//! queries (`catalog`). The shell has reads of its own (Home's vault search, and
//! whatever the chat and the backup screens ask the vault that is not an app's):
//! they are named here, in `manifest.json` beside this file, under the app id
//! `shell`, and `load` serves them exactly as it serves an app's.
//!
//! `shell` is NOT one of the eight apps. It has no actions (so `act` refuses it:
//! the catalogue lookup has no such app), no grant, no tile and no place in
//! `catalog::APPS`, and the assistant's export never sees it. A query is added by
//! its lane in its own block of the manifest, with its reader in `load.rs`.

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("manifest.json");

/// The shell's id in a `LoadRequest`.
pub const APP_ID: &str = "shell";

/// The parsed manifest.
///
/// # Panics
/// If the committed manifest does not parse: a build-time fact about a file in
/// this crate, which `the_committed_manifest_parses` keeps unreachable.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/core/src/shell/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_committed_manifest_parses() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert!(manifest.actions.is_empty(), "the shell has no actions");
        assert!(manifest.query("search").is_some());
    }
}
