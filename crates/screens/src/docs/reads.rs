//! DOCS'S "WHAT DOCS MAY READ" (owner, 2026-11-19): the kit's one reads page with Docs as the
//! parameter. The kinds it lists are the manifest's read scopes outside Docs's own, in a member's
//! words (`tests/reads_page.rs` holds the list against `manifest.json`).

use centraid_api_proto::core_v1 as wire;

use crate::kit::reads_page::{self, ReadsSpec};
use crate::screen::Screen;
use crate::strings::reads as words;

/// Docs's reads, as the kit's page takes them.
pub static SPEC: ReadsSpec = ReadsSpec {
    app: "docs",
    name: crate::strings::docs::app_title,
    reads: words::docs_reads,
    writes: words::docs_writes,
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    reads_page::build(&SPEC)
}
