//! THE SHELL'S READS THAT ARE THE PHONE'S OWN LEDGER (#1135, lane H2): the
//! backup's status, the destinations, what waits and why, the held vaults.
//! They are named queries in `shell/manifest.json` like any other, but a vault
//! table does not hold them, so `Handle::load` offers them here before the
//! vault reader.

use centraid_api_proto::core_v1 as wire;

use crate::error::{CoreError, Result};
use crate::handle::HandleState;

/// The queries the FRONT answers itself. Every other shell read is about the
/// vault in front, and the front forwards it there.
const FRONT_QUERIES: [&str; 1] = ["holdings"];

/// Whether `request` is a read of the shelf and not of a vault.
pub(crate) fn is_front_read(request: &wire::LoadRequest) -> bool {
    request.app == crate::shell::ID && FRONT_QUERIES.contains(&request.query.as_str())
}

/// The answer to a ledger query, or `None` when the name is a vault read.
pub(crate) fn load(
    handle: &HandleState,
    request: &wire::LoadRequest,
) -> Option<Result<wire::LoadResponse>> {
    if is_front_read(request) {
        return Some(holdings(handle));
    }
    match request.query.as_str() {
        super::backup_reads::STATUS => Some(super::backup_reads::status(handle)),
        _ => None,
    }
}

/// `shell.holdings`: the vaults this phone holds.
fn holdings(handle: &HandleState) -> Result<wire::LoadResponse> {
    let vaults = handle.vaults().ok_or_else(|| CoreError::InvalidRequest {
        detail: "this core is not the door to a shelf of vaults".to_owned(),
    })?;
    Ok(wire::LoadResponse {
        answer: Some(wire::AppQueryResponse {
            answer: Some(wire::app_query_response::Answer::Holdings(
                vaults.holdings(),
            )),
        }),
        tables: vec![crate::vaults::SHELF_TABLE.to_owned()],
    })
}
