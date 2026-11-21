//! MONEY'S "WHAT MONEY MAY READ" (owner, 2026-11-19): the kit's one reads page with Money as the
//! parameter. The kinds it lists are the manifest's read scopes outside Money's own, in a member's
//! words (`tests/reads_page.rs` holds the list against `manifest.json`).

use centraid_api_proto::core_v1 as wire;

use crate::kit::reads_page::{self, ReadsSpec};
use crate::screen::Screen;
use crate::strings::reads as words;

/// Money's reads, as the kit's page takes them.
pub static SPEC: ReadsSpec = ReadsSpec {
    app: "money",
    name: crate::strings::money::app_title,
    reads: words::money_reads,
    writes: words::money_writes,
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    reads_page::build(&SPEC)
}
