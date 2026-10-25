//! THE SHELL'S READS THAT ARE THE PHONE'S OWN LEDGER (#1135, lane H2): the
//! backup's status, the destinations, what waits and why, the held vaults.
//! They are named queries in `shell/manifest.json` like any other, but a vault
//! table does not hold them, so `Handle::load` offers them here before the
//! vault reader.

use centraid_api_proto::core_v1 as wire;

use crate::error::Result;
use crate::handle::HandleState;

/// The answer to a ledger query, or `None` when the name is a vault read.
pub(crate) fn load(
    handle: &HandleState,
    request: &wire::LoadRequest,
) -> Option<Result<wire::LoadResponse>> {
    match request.query.as_str() {
        super::backup_reads::STATUS => Some(super::backup_reads::status(handle)),
        _ => None,
    }
}
