//! THE APPS' CATALOGUES, AS ONE LOOKUP (#1135).
//!
//! An app carries a manifest and a Rust action table that says which vault command
//! each manifest action runs. `load` and `act` address an app by its id, so this is the one place
//! that turns an id into both halves: the parsed manifest (what the app
//! declares) and the command an action resolves to (what the core runs).
//!

use centraid_domain::actions::ActionRow;
use centraid_domain::manifest::Manifest;

/// One app's catalogue.
#[derive(Clone, Copy)]
pub(crate) struct App {
    pub id: &'static str,
    manifest: fn() -> &'static Manifest,
    actions: &'static [ActionRow],
}

impl App {
    /// The app's parsed manifest.
    pub fn manifest(&self) -> &'static Manifest {
        (self.manifest)()
    }

    /// The vault command an action runs, from the app's Rust action table.
    pub fn command_of(&self, action: &str) -> Option<&'static str> {
        centraid_domain::actions::find(self.actions, action).map(|row| row.command)
    }
}

/// Every app the new plane declares: none until `centraid_domain::ACTIONS` names one.
pub(crate) const APPS: [App; 0] = [];

/// THE SHELL'S OWN CATALOGUE: what Home, search, the chat's history and the vault's plumbing read
/// and write, which is not one app's. It is addressed like an app (`load("shell", ..)`,
/// `act("shell", ..)`) and is not one of the [`APPS`].
pub(crate) const SHELL: App = App {
    id: crate::shell::ID,
    manifest: crate::shell::manifest,
    actions: &crate::shell::ACTIONS,
};

/// The app of that id (or the shell), or `None`.
pub(crate) fn app(id: &str) -> Option<App> {
    APPS.iter()
        .find(|app| app.id == id)
        .copied()
        .or_else(|| (id == SHELL.id).then_some(SHELL))
}

/// The manifest `load` answers from for an app id: one app's, or
/// the shell's own catalogue ([`crate::shell`], no app: it has no actions, so
/// [`app`] and `act` never see it).
pub(crate) fn manifest_of(id: &str) -> Option<&'static Manifest> {
    if id == crate::shell::ID {
        return Some(crate::shell::manifest());
    }
    app(id).map(|app| app.manifest())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shell_is_addressable_and_is_not_one_of_the_eight_apps() {
        assert!(app("shell").is_some());
        assert!(APPS.iter().all(|app| app.id != "shell"));
        let shell = SHELL.manifest();
        assert_eq!(shell.id, "shell");
        for action in &shell.actions {
            assert!(
                SHELL.command_of(&action.name).is_some(),
                "shell.{} has no command in its action table",
                action.name
            );
        }
        for row in crate::shell::ACTIONS {
            assert!(
                shell.action(row.action).is_some(),
                "{} is not declared",
                row.action
            );
        }
    }
}
