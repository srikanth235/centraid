//! THE APP ROSTER: the one list of the apps a chat card may name and a chat may be scoped to
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135), R-1135-7-1).
//!
//! An app is a word the product interprets, not one the vault does: no `CHECK` names it
//! (principle 6 of the model), so a roster that changes is a build and not a migration. Three
//! readers take this constant and no copy of it: the `thread.*` commands' input schemas
//! ([`crate::commands::thread`]), the assistant's `App` (`crates/assist/src/app.rs`, whose ids are
//! indexed out of [`APPS`]), and the screens' own list, which a test holds equal to [`ids`].
//!
//! Every app a member opens is a chat scope, Locker included: the assistant has the owner's access
//! to a Locker item's plain rows (the owner's ruling of 2026-10-22), and a sealed value is never in
//! a prompt or an answer (R-1088-3). Health is on it too: its `daily_figure` and `workout` kinds
//! are read and written through its manifest like any app's (owner ruling of 2026-10-24, #1135;
//! R-1129-11 is superseded). One app is one word: the events a member keeps are Calendar's and the tasks are
//! Reminders' (round 10 of #1173 split Agenda in two), so a card, a search hit, a write and a chat
//! scope say `calendar` or `reminders`, and nothing here maps one app onto another. A card or a
//! scope an older build stored as `agenda` is read through [`legacy`].

/// One app a card may name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RosterApp {
    /// The id a shell routes by, and a card and a thread store.
    pub id: &'static str,
}

/// The roster, in registry order. A card may name any of them and a chat may be scoped to any.
pub const APPS: [RosterApp; 9] = [
    RosterApp { id: "calendar" },
    RosterApp { id: "docs" },
    RosterApp { id: "health" },
    RosterApp { id: "locker" },
    RosterApp { id: "money" },
    RosterApp { id: "notes" },
    RosterApp { id: "people" },
    RosterApp { id: "photos" },
    RosterApp { id: "reminders" },
];

/// Every id a card may name, and a chat may be scoped to, in registry order.
pub fn ids() -> impl Iterator<Item = &'static str> {
    APPS.iter().map(|app| app.id)
}

/// Whether a card may name this app, and a chat may be scoped to it.
#[must_use]
pub fn is_app(id: &str) -> bool {
    ids().any(|known| known == id)
}

/// The app a stored `agenda` card or chat scope names now: the app of its entity kind, since the one
/// app became two. A task (and a project, section or area) is Reminders'; everything else Agenda held,
/// an event above all, is Calendar's. Any other id is returned as it is.
#[must_use]
pub fn legacy<'a>(app: &'a str, entity: &str) -> &'a str {
    if app != "agenda" {
        return app;
    }
    match entity {
        "task" | "project" | "section" | "area" | "list" => "reminders",
        _ => "calendar",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_agenda_card_is_read_as_the_app_of_its_entity() {
        assert_eq!(legacy("agenda", "task"), "reminders");
        assert_eq!(legacy("agenda", "event"), "calendar");
        assert_eq!(legacy("agenda", ""), "calendar");
        assert_eq!(legacy("notes", "task"), "notes");
        assert!(!is_app("agenda"));
    }

    #[test]
    fn every_app_is_a_card_and_a_scope() {
        assert_eq!(
            ids().collect::<Vec<_>>(),
            [
                "calendar",
                "docs",
                "health",
                "locker",
                "money",
                "notes",
                "people",
                "photos",
                "reminders"
            ]
        );
        assert!(is_app("locker") && is_app("health"));
        assert!(
            !is_app("tasks"),
            "the tasks are Reminders': there is no `tasks` app"
        );
    }
}
