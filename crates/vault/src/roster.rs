//! THE APP ROSTER: the one list of the apps a chat card may name and a chat may be scoped to
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135), R-1135-7-1).
//!
//! An app is a word the product interprets, not one the vault does: no `CHECK` names it
//! (principle 6 of the model), so a roster that changes is a build and not a migration. Three
//! readers take this constant and no copy of it: the `thread.*` commands' input schemas
//! ([`crate::commands::thread`]), the assistant's `App` (`crates/assist/src/app.rs`, whose ids and
//! `opens_in` are indexed out of [`APPS`]), and the Kotlin `ChatMachine`, whose list a test holds
//! equal to [`ids`] (`ChatScopeSpec`).
//!
//! Locker is not on it: a secret that was never in a prompt cannot be in an answer (R-1088-3).
//! Health is not on it either (R-1129-11). `tasks` is a *domain* a card, a search hit and a write
//! name that opens in Agenda (R-1128-D1), so it is on the roster and is no scope (R-1128-F2).

/// One app a card may name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RosterApp {
    /// The id a shell routes by, and a card and a thread store.
    pub id: &'static str,
    /// The id of the app a member opens this one in: itself, except for a domain folded into
    /// another app (`tasks` opens in `agenda`).
    pub opens_in: &'static str,
}

const fn app(id: &'static str, opens_in: &'static str) -> RosterApp {
    RosterApp { id, opens_in }
}

/// The roster, in registry order. A chat is scoped to an entry that opens in itself.
pub const APPS: [RosterApp; 7] = [
    app("agenda", "agenda"),
    app("docs", "docs"),
    app("money", "money"),
    app("notes", "notes"),
    app("people", "people"),
    app("photos", "photos"),
    app("tasks", "agenda"),
];

/// Every id a card may name, in registry order.
pub fn ids() -> impl Iterator<Item = &'static str> {
    APPS.iter().map(|app| app.id)
}

/// Every id a chat may be scoped to: the apps that open in themselves.
pub fn scopes() -> impl Iterator<Item = &'static str> {
    APPS.iter()
        .filter(|app| app.id == app.opens_in)
        .map(|app| app.id)
}

/// Whether a card may name this app.
#[must_use]
pub fn is_card_app(id: &str) -> bool {
    ids().any(|known| known == id)
}

/// Whether a chat may be scoped to this app.
#[must_use]
pub fn is_scope(id: &str) -> bool {
    scopes().any(|known| known == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_is_an_app_that_opens_in_itself() {
        assert_eq!(
            scopes().collect::<Vec<_>>(),
            ["agenda", "docs", "money", "notes", "people", "photos"]
        );
        assert!(is_card_app("tasks") && !is_scope("tasks"));
        assert!(!is_card_app("locker") && !is_card_app("health"));
        // Every domain opens in an app the roster has.
        assert!(APPS.iter().all(|app| is_scope(app.opens_in)));
    }
}
