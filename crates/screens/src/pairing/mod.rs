//! PAIRING A GATEWAY, AND FINDING IT AGAIN (#1135, wave 4, lane H2): the
//! pairing screen, its scanner and the discovery matching that follows a paired
//! gateway to its new addresses. Bonjour and NSD browsing are the shell's
//! (`BrowseGateways`); everything that decides what a person sees is here.
//!
//! | Piece | Route name | Machine |
//! |---|---|---|
//! | Pair with a gateway: scan or paste its code, compare the safety number | [`LAPTOP`] | [`laptop`] |
//! | Which sighting is which gateway, and which addresses may be offered | | [`matching`] |
//! | One foreground browse, matched and handed to the core | | [`discovery`] |
//!
//! Pairing runs on the core the screen runtime is attached to, so it works on a
//! phone with no vault (the custody core) as on one with: the same door.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::custody::secrets::VaultSecrets;

pub mod discovery;
mod door;
pub mod laptop;
pub mod matching;

/// The pairing screen's route name.
pub const LAPTOP: &str = "pair.laptop";

/// Every pairing screen, registered under its route name. Pairing keeps no
/// secret of its own (the code's secret is spent on first use), so it reads
/// nothing from the shared cache.
#[must_use]
pub fn registry(secrets: &VaultSecrets) -> Registry {
    let _ = secrets;
    Registry::default().with(LAPTOP, laptop::build)
}

/// The routes a screen of another area hands to a shell to open pairing
/// (Backup's "add a gateway", Settings).
pub mod routes {
    use super::{LAPTOP, wire};

    /// The pairing screen. It takes no argument.
    #[must_use]
    pub fn laptop() -> wire::Route {
        wire::Route {
            screen: LAPTOP.to_owned(),
            args: None,
        }
    }
}
