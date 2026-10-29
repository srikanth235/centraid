//! THE BACKUP SCREEN (#1135, wave 4, lane H2): where the vault's backup stands,
//! the gateways it goes to, where the recovery key is kept, the transfer rule
//! and the videos bit. Every word is made here.
//!
//! | Piece | What it decides |
//! |---|---|
//! | [`home`] | the screen `backup.home`: the line, the gateways, the controls, the key |
//! | [`apps`] | "In this backup": one row per app, what it holds and whether it is backed up |
//! | [`line`] | the one honest line Home draws too: never more than a gateway acknowledged |
//! | [`reading`] | the ledger's reading, and the `backup-status` query behind it |
//! | [`rule`] | the member's transfer rule and the videos bit, as this phone keeps them |
//! | [`key`] | where the recovery key is, worded for the platform |
//! | [`freeze`] | what is only on this phone when the vault moved |
//! | [`claim`] | what a sentence may claim about backup, and what a pass is told in words |
//!
//! **"Free up space" is Photos'**: the count, the verb and its sentences are
//! `photos::keep_originals::FreeUpRow` over `photos::free_up`, so this
//! screen carries no second copy of them.
//!
//! **"Back up now" asks for a pass; it does not schedule one.** When a pass runs,
//! under which rule and on which link is the pass service's ([`crate::passes`]);
//! the screen's only decision is that the member tapped, and it passes the
//! rule and the videos bit it shows ([`doors`]).

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

pub mod apps;
pub mod claim;
mod doors;
pub mod freeze;
pub mod home;
pub mod key;
pub mod line;
pub mod reading;
pub mod rule;

#[cfg(test)]
mod tests;

pub const HOME: &str = "backup.home";

/// The tab the Backup screen is the root of.
pub const TAB: &str = "backup";

/// Every backup screen, registered under its route name.
#[must_use]
pub fn registry(secrets: &VaultSecrets) -> Registry {
    let secrets = secrets.clone();
    Registry::default().with(HOME, move |route| home::build(route, &secrets))
}

/// The routes the backup screens hand to a shell inside a view state, and that
/// Home and Settings build to open them.
pub mod routes {
    use centraid_api_proto::core_v1 as wire;

    use super::HOME;

    /// The Backup screen.
    #[must_use]
    pub fn home() -> wire::Route {
        wire::Route {
            screen: HOME.to_owned(),
            args: Some(wire::route::Args::BackupHome(wire::BackupHomeRoute {})),
        }
    }

    /// Pairing a backup device: the pairing lane's page. Until it defines its
    /// own name constant this builds the route by the name the shells already
    /// use, so the one place to swap is here.
    #[must_use]
    pub fn add_destination() -> wire::Route {
        wire::Route {
            screen: "pair.laptop".to_owned(),
            args: None,
        }
    }

    /// The recovery key, shown behind the passcode: the custody lane's page.
    /// Built by name for the same reason as [`add_destination`].
    #[must_use]
    pub fn show_key() -> wire::Route {
        wire::Route {
            screen: "words.show".to_owned(),
            args: None,
        }
    }
}
