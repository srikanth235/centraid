//! WHAT A RESTORE STILL OWES (#1209, R3), for the screens that draw it beside the photographs: the
//! library's scope line, the arrow on a photograph whose original has not come back, and the
//! viewer's "still coming back". One read of the Backup status, taken when a screen loads; a
//! failed read says nothing is owed, because the member is told nothing false that way.

use centraid_api_proto::core_v1 as wire;

use crate::backup::reading::load;
use crate::kit::read::Reading as Read;
use crate::screen::Ctx;

/// The restore's progress, while one is owed.
#[must_use]
pub fn owed(ctx: &Ctx) -> Option<wire::RestoreProgress> {
    match load(ctx) {
        Read::Data(standing) => standing.reading.restoring,
        _ => None,
    }
}

/// Whether the originals are still coming back: the viewer and the grid say so for a photograph
/// that has a preview and no original here.
#[must_use]
pub fn originals_owed(progress: Option<&wire::RestoreProgress>) -> bool {
    progress.is_some_and(|p| p.originals_back < p.originals_total)
}
