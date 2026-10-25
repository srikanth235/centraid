//! THE NINE APPS' CATALOGUES, AS ONE LOOKUP (#1135).
//!
//! Each app crate embeds its `manifest.json` and carries a Rust action table
//! (`commands::ACTIONS`) that says which vault command each manifest action
//! runs. `load` and `act` address an app by its id, so this is the one place
//! that turns an id into both halves: the parsed manifest (what the app
//! declares) and the command an action resolves to (what the core runs).
//!
//! An app is added here and in `Cargo.toml`, and nowhere else in the dispatch.

use centraid_apps_kit::actions::ActionRow;
use centraid_apps_kit::manifest::Manifest;

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
        centraid_apps_kit::actions::find(self.actions, action).map(|row| row.command)
    }
}

macro_rules! app {
    ($id:literal, $krate:ident, $rows:expr) => {
        App {
            id: $id,
            manifest: $krate::manifest::manifest,
            actions: &$rows,
        }
    };
}

/// Every app, in the order the product lists them.
pub(crate) const APPS: [App; 8] = [
    app!(
        "agenda",
        centraid_apps_agenda,
        centraid_apps_agenda::ACTIONS
    ),
    app!("docs", centraid_apps_docs, centraid_apps_docs::ACTIONS),
    app!(
        "health",
        centraid_apps_health,
        centraid_apps_health::manifest::ACTIONS
    ),
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
];

/// THE SHELL'S OWN CATALOGUE: what Home, search, the chat's history and the vault's plumbing read
/// and write, which is not one app's. It is addressed like an app (`load("shell", ..)`,
/// `act("shell", ..)`) and is not one of the eight [`APPS`]: the assistant's catalogue and the
/// training harness carry the eight and never this.
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
        assert_eq!(actions, 153, "the eight manifests declare 153 actions");
    }

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

    /// THERE IS NO `tasks` APP (#1128, the owner's ruling): Tasks were folded into Agenda, so no
    /// app id, manifest id, crate or query namespace is `tasks`. `task` stays what it is: a vault
    /// entity kind and a chat kind.
    #[test]
    fn no_app_manifest_crate_or_query_namespace_is_called_tasks() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert!(
            !root.join("crates/apps/tasks").exists(),
            "crates/apps/tasks came back: the tasks are Agenda's"
        );
        for manifest in ["Cargo.toml", "crates/core/Cargo.toml"] {
            let text = std::fs::read_to_string(root.join(manifest)).expect("a manifest");
            assert!(
                !text.contains("apps-tasks") && !text.contains("apps/tasks"),
                "{manifest} names a tasks crate"
            );
        }
        assert!(
            app("tasks").is_none(),
            "the catalogue carries a `tasks` app"
        );
        for app in APPS {
            assert_ne!(app.id, "tasks");
            assert_ne!(app.manifest().id, "tasks");
            for query in &app.manifest().queries {
                assert!(
                    !query.name.starts_with("tasks"),
                    "{}.{} is a `tasks` query",
                    app.id,
                    query.name
                );
            }
        }
        assert!(!centraid_vault::roster::is_app("tasks"));
        assert!(
            centraid_assist::App::from_id("tasks").is_none(),
            "the assistant reads a `tasks` app"
        );
    }
}
