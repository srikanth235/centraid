//! THE SHELL'S OWN CATALOGUE (#1135, wave 4): reads that are not one app's.
//!
//! Home's tiles, a search across the vault, the chat's history and the
//! backup's status are questions the shell asks, and they are named queries
//! like any app's: `load("shell", "<query>", params)`, declared in
//! `manifest.json` and answered by a reader here. There are no unnamed reads.
//! `shell` is **not one of the eight apps** (`crate::catalog::APPS`): the
//! assistant and the training harness never see it, and it has no actions —
//! the shell's writes are the apps' (`act`) or the core's own doors.
//!
//! A reader takes the [`Handle`] and not only the vault, because some of what
//! the shell asks about is the phone's own ledger (the backup status), which is
//! not a vault table. Each lane adds its queries in its own block of
//! `manifest.json` and its own reader module.

use std::sync::OnceLock;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::manifest::{Manifest, parse_manifest};

use crate::error::{CoreError, Result};
use crate::handle::Handle;

/// The app id the shell's queries are addressed under.
pub const ID: &str = "shell";

/// The embedded catalogue.
pub const MANIFEST_JSON: &str = include_str!("manifest.json");

/// The parsed catalogue.
///
/// # Panics
/// When `manifest.json` does not parse; the test below holds it.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/core/src/shell/manifest.json must parse")
    })
}

/// Run one of the shell's queries.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a query the catalogue lacks, one this
/// core has no reader for, or a parameter it does not take.
pub fn load(handle: &Handle, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
    if manifest().query(&request.query).is_none() {
        return Err(CoreError::InvalidRequest {
            detail: format!("the shell declares no query `{}`", request.query),
        });
    }
    let _ = handle;
    Err(CoreError::InvalidRequest {
        detail: format!(
            "the shell declares the query `{}` and this core has no reader for it yet",
            request.query
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_parses_and_is_not_an_app() {
        assert_eq!(manifest().id, ID);
        assert!(manifest().actions.is_empty(), "the shell has no actions");
        assert!(crate::catalog::app(ID).is_none());
    }
}
