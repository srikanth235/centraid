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
//! a prompt or an answer (R-1088-3). Health is not on it until the assistant has Health kinds
//! (R-1129-11). One app is one word: the tasks a member keeps are Agenda's (#1128), so a card, a
//! search hit, a write and a chat scope all say `agenda`, and nothing here maps one app onto
//! another.

/// One app a card may name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RosterApp {
    /// The id a shell routes by, and a card and a thread store.
    pub id: &'static str,
}

/// The roster, in registry order. A card may name any of them and a chat may be scoped to any.
pub const APPS: [RosterApp; 7] = [
    RosterApp { id: "agenda" },
    RosterApp { id: "docs" },
    RosterApp { id: "locker" },
    RosterApp { id: "money" },
    RosterApp { id: "notes" },
    RosterApp { id: "people" },
    RosterApp { id: "photos" },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_app_is_a_card_and_a_scope() {
        assert_eq!(
            ids().collect::<Vec<_>>(),
            [
                "agenda", "docs", "locker", "money", "notes", "people", "photos"
            ]
        );
        assert!(is_app("locker") && !is_app("health"));
        assert!(
            !is_app("tasks"),
            "the tasks are Agenda's: there is no `tasks` app"
        );
    }
}
