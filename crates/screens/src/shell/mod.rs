//! THE SHELL'S OWN SCREENS (#1135, lane H1): the band, settings and the export, and the runtime the
//! shells attach.
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Home's root, empty | [`HOME`] | [`home`] |
//! | Settings | [`SETTINGS`] | [`settings`] |
//! | Export everything | [`EXPORT`] | [`export`] |
//!
//! Home is the root of the `home` tab; the springboard went with the apps it listed, and the shell
//! frame fills the page.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub mod band;
pub mod export;
pub mod home;
pub mod settings;

pub const HOME: &str = "home.springboard";
pub const SETTINGS: &str = "home.settings";
pub const EXPORT: &str = "home.export";

/// The tab Home is the root of.
pub const TAB: &str = band::HOME;

/// Every shell screen, registered under its route name.
#[must_use]
pub fn registry(secrets: &crate::custody::secrets::VaultSecrets) -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(SETTINGS, settings::build(secrets))
        .with(EXPORT, export::build)
}

/// The routes the shell's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{HOME, SETTINGS, wire};

    /// Home, the springboard.
    #[must_use]
    pub fn home() -> wire::Route {
        wire::Route {
            sheet: false,
            screen: HOME.to_owned(),
            args: Some(wire::route::Args::Home(wire::HomeRoute {})),
        }
    }

    /// Settings: the appearance, the vault, the backup, the recovery key and the version.
    #[must_use]
    pub fn settings() -> wire::Route {
        wire::Route {
            sheet: false,
            screen: SETTINGS.to_owned(),
            args: Some(wire::route::Args::Settings(wire::SettingsRoute {})),
        }
    }

    /// The assistant, asking `question` in `scope` (an app id, or empty for every
    /// app). The chat screen takes it; this is only the value.
    #[must_use]
    pub fn ask(question: &str, scope: &str) -> wire::Route {
        wire::Route {
            sheet: false,
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
