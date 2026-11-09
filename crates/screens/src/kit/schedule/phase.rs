//! WHERE A HOME'S READ STANDS, shared by the two apps' homes: loading, failed, refused by the vault's
//! gate, or ready, and the answer a read stopped with.

use centraid_api_proto::core_v1 as wire;

use crate::kit::read::Reading;

/// Where a read stands.
pub enum Phase {
    Loading,
    Failed,
    /// The vault would not let the app read: the kit's gate.
    Denied(wire::AppQueryDenial),
    Ready,
}

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
