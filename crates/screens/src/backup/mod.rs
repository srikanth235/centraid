//! THE BACKUP SCREEN (#1135, wave 4, lane H2): where the vault's backup stands,
//! the gateways it goes to, where the recovery key is kept, the transfer rule
//! and freeing the space originals hold. Every word is made here.

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

/// Every backup screen, registered under its route name.
#[must_use]
pub fn registry(secrets: &VaultSecrets) -> Registry {
    let _ = secrets;
    Registry::default()
}
