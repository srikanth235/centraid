//! WHY A HOME'S READ STOPPED, shared by the two apps' homes: it failed, or the vault's gate refused it.

use centraid_api_proto::core_v1 as wire;

use crate::kit::read::Reading;

/// Why a read stopped.
pub enum Stop {
    Failed,
    Denied(wire::AppQueryDenial),
}

/// A reading as a result: the data, or why the read stopped.
///
/// # Errors
/// [`Stop::Denied`] when the gate refused, [`Stop::Failed`] when the read failed.
pub fn get<T>(reading: Reading<T>) -> Result<T, Stop> {
    match reading {
        Reading::Data(data) => Ok(data),
        Reading::Denied(denial) => Err(Stop::Denied(denial)),
        Reading::Failed => Err(Stop::Failed),
    }
}
