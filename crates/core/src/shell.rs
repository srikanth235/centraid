//! THE SHELL'S CATALOGUE (#1135): the reads and writes that are not one app's.
//!
//! Home's tiles, vault search, the chat's history and the vault's plumbing are named queries and
//! actions in ONE manifest, `shell/manifest.json` (app id `shell`), so a screen reaches them the
//! way it reaches an app's: `load("shell", query, params)` and `act("shell", action, input)`. The
//! manifest is parsed like an app's and is not one of the eight apps ([`crate::catalog::APPS`]):
//! the assistant's catalogue, the training export and the action census carry the eight only.
//!
//! Each shell lane owns a block of the manifest and its action rows below.

use std::sync::OnceLock;

use centraid_apps_kit::actions::{ActionRow, act, confirmed};
use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, embedded verbatim like an app's.
pub const MANIFEST_JSON: &str = include_str!("shell/manifest.json");

/// The shell's app id.
pub const ID: &str = "shell";

/// The parsed manifest.
///
/// # Panics
/// If the committed manifest does not parse: a build-time fact about a file in this crate,
/// held unreachable by the catalogue's tests.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/core/src/shell/manifest.json must parse")
    })
}

/// Which vault command each shell action runs.
pub const ACTIONS: [ActionRow; 3] = [
    // ---- chat (lane I) ----
    act("rename-chat", "thread.rename"),
    // a chat has no trash (R-CHAT-8): its delete is the shared permanent one
    confirmed("delete-chat", "entity.purge"),
    confirmed("clear-chats", "thread.clear"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_committed_manifest_parses_and_is_the_shell() {
        assert_eq!(manifest().id, ID);
        assert_eq!(manifest().manifest_version, 1);
    }
}
