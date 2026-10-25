//! THE VAULT'S CUSTODY (#1135, wave 4, lane H2): the 24 words, the seed this
//! phone keeps beside them, and the screens that make, show, enter and restore
//! them. The shell keeps bytes (Keychain, Keystore, iCloud Keychain, Block
//! Store); every decision about them is here ([`secrets`]).

use crate::Registry;

pub mod secrets;

/// Every custody screen, registered under its route name. `secrets` is the one
/// cache the whole runtime shares.
#[must_use]
pub fn registry(secrets: &secrets::VaultSecrets) -> Registry {
    let _ = secrets;
    Registry::default()
}
