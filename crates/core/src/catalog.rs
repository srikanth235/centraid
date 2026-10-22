//! THE NINE APPS' CATALOGUES, AS ONE LOOKUP (#1135).
//!
//! Each app crate embeds its `manifest.json` and carries a Rust action table
//! (`commands::ACTIONS`) that says which vault command each manifest action
//! runs. `load` and `act` address an app by its id, so this is the one place
//! that turns an id into both halves: the parsed manifest (what the app
//! declares) and the command an action resolves to (what the core runs).
//!
//! An app is added here and in `Cargo.toml`, and nowhere else in the dispatch.

use centraid_apps_kit::manifest::Manifest;

/// One app's catalogue.
#[derive(Clone, Copy)]
pub(crate) struct App {
    pub id: &'static str,
    manifest: fn() -> &'static Manifest,
    command_of: fn(&str) -> Option<&'static str>,
}

impl App {
    /// The app's parsed manifest.
    pub fn manifest(&self) -> &'static Manifest {
        (self.manifest)()
    }

    /// The vault command an action runs, from the app's Rust action table.
    pub fn command_of(&self, action: &str) -> Option<&'static str> {
        (self.command_of)(action)
    }
}

macro_rules! app {
    ($id:literal, $krate:ident, $rows:expr) => {
        App {
            id: $id,
            manifest: $krate::manifest::manifest,
            command_of: |action| {
                $rows
                    .iter()
                    .find(|row| row.action == action)
                    .map(|row| row.command)
            },
        }
    };
}

/// Every app, in the order the product lists them.
pub(crate) const APPS: [App; 9] = [
    app!(
        "agenda",
        centraid_apps_agenda,
        centraid_apps_agenda::ACTIONS
    ),
    app!("docs", centraid_apps_docs, centraid_apps_docs::ACTIONS),
    App {
        id: "health",
        manifest: centraid_apps_health::manifest::manifest,
        command_of: |action| {
            centraid_apps_health::manifest::ACTIONS
                .iter()
                .find(|(name, _)| *name == action)
                .map(|(_, command)| *command)
        },
    },
    app!(
        "locker",
        centraid_apps_locker,
        centraid_apps_locker::commands::ACTIONS
    ),
    app!(
        "money",
        centraid_apps_money,
        centraid_apps_money::commands::ACTIONS
    ),
    app!("notes", centraid_apps_notes, centraid_apps_notes::ACTIONS),
    app!(
        "people",
        centraid_apps_people,
        centraid_apps_people::ACTIONS
    ),
    app!(
        "photos",
        centraid_apps_photos,
        centraid_apps_photos::ACTIONS
    ),
    app!("tasks", centraid_apps_tasks, centraid_apps_tasks::ACTIONS),
];

/// The app of that id, or `None`.
pub(crate) fn app(id: &str) -> Option<App> {
    APPS.iter().find(|app| app.id == id).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_manifest_action_resolves_to_a_command_and_every_app_is_counted() {
        let mut actions = 0;
        for app in APPS {
            let manifest = app.manifest();
            assert_eq!(manifest.id, app.id);
            for action in &manifest.actions {
                assert!(
                    app.command_of(&action.name).is_some(),
                    "{}.{} has no command in its action table",
                    app.id,
                    action.name
                );
                actions += 1;
            }
        }
        assert_eq!(actions, 145, "the nine manifests declare 145 actions");
    }
}
