//! PAIRING A GATEWAY, AND FINDING IT AGAIN (#1135, wave 4, lane H2): the
//! pairing screen, its scanner and the discovery matching that follows a paired
//! gateway to its new addresses. Bonjour and NSD browsing are the shell's;
//! everything that decides what a person sees is here.

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

/// Every pairing screen, registered under its route name.
#[must_use]
pub fn registry(secrets: &VaultSecrets) -> Registry {
    let _ = secrets;
    Registry::default()
}
