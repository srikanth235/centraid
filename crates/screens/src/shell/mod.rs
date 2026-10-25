//! THE SHELL'S OWN SCREENS (#1135, lane H1): Home, the springboard, and its
//! search, plus the band, the one table that sends a row to its page and the
//! runtime the shells attach.
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | The springboard | [`HOME`] | [`home`] |
//! | Search over every app | [`SEARCH`] | [`search`] |
//!
//! Home is the root of the `home` tab; an app opens as a page pushed on that
//! tab and back returns to Home. A tile and a search row carry the
//! [`wire::Route`] to push, so a shell never names a destination.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub mod band;
pub mod home;
pub mod policy;
pub mod row_routes;
pub mod search;
pub mod tiles;

pub const HOME: &str = "home.springboard";
pub const SEARCH: &str = "home.search";

/// The tab Home is the root of.
pub const TAB: &str = band::HOME;

/// Every shell screen, registered under its route name.
#[must_use]
pub fn registry(secrets: &crate::custody::secrets::VaultSecrets) -> Registry {
    Registry::default()
        .with(HOME, home::build(secrets))
        .with(SEARCH, search::build)
}

/// The routes the shell's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{HOME, SEARCH, wire};

    /// Home, the springboard.
    #[must_use]
    pub fn home() -> wire::Route {
        wire::Route {
            screen: HOME.to_owned(),
            args: Some(wire::route::Args::Home(wire::HomeRoute {})),
        }
    }

    /// Home's search over every app.
    #[must_use]
    pub fn search() -> wire::Route {
        wire::Route {
            screen: SEARCH.to_owned(),
            args: Some(wire::route::Args::HomeSearch(wire::HomeSearchRoute {})),
        }
    }

    /// The assistant, asking `question` in `scope` (an app id, or empty for every
    /// app). The chat screen takes it; this is only the value.
    #[must_use]
    pub fn ask(question: &str, scope: &str) -> wire::Route {
        wire::Route {
            screen: ASK.to_owned(),
            args: Some(wire::route::Args::Ask(wire::ShellAskRoute {
                question: question.to_owned(),
                scope: scope.to_owned(),
            })),
        }
    }

    /// The registered name of the screen an Ask opens.
    pub const ASK: &str = "chat.ask";
}

/// A runtime with the shell's screens and one tab, `home`, rooted at Home. The
/// shell's real runtime composes [`registry`] with the other lanes'; this is
/// what Home's own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(&crate::custody::secrets::VaultSecrets::new()),
        vec![(TAB.to_owned(), routes::home())],
    )
    .with_band(band::view)
}
