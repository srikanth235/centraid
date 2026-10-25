//! THE PASS (#1135, wave 4, lane H2): when a backup pass runs, under which rule
//! and on which link, and what the member is told about it. The pass itself is
//! the core's `drain`; the shell performs it as a `CoreCall` and schedules the
//! operating system's windows, and everything it decides is here.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

/// The screens that run as long as the runtime does, with no view: see
/// [`crate::Runtime::with_services`].
#[must_use]
pub fn services() -> Vec<wire::Route> {
    Vec::new()
}

/// Every pass screen and service, registered under its route name.
#[must_use]
pub fn registry(secrets: &VaultSecrets) -> Registry {
    let _ = secrets;
    Registry::default()
}
