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
//! Locker is on it as a card domain and no chat scope: the assistant has the owner's access to a
//! Locker item's plain rows (the owner's ruling of 2026-10-22), so a card may name one, but a
//! sealed value is never in a prompt or an answer (R-1088-3), and a chat scoped to Locker is a
//! shell surface nobody has ruled on. Health is not on it (R-1129-11). `tasks` is a *domain* a card, a search hit and a write
//! name that opens in Agenda (R-1128-D1), so it is on the roster and is no scope (R-1128-F2).

/// One app a card may name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RosterApp {
    /// The id a shell routes by, and a card and a thread store.
    pub id: &'static str,
    /// The id of the app a member opens this one in: itself, except for a domain folded into
    /// another app (`tasks` opens in `agenda`).
    pub opens_in: &'static str,
    /// Whether a chat may be scoped to it: an app that opens in itself, but for Locker.
    pub scope: bool,
}

const fn app(id: &'static str, opens_in: &'static str) -> RosterApp {
    RosterApp {
        id,
        opens_in,
        scope: same(id, opens_in),
    }
}

/// An app a card may name that opens in itself and is no chat scope.
const fn card_only(id: &'static str) -> RosterApp {
    RosterApp {
        id,
        opens_in: id,
        scope: false,
    }
}

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut at = 0;
    while at < a.len() {
        if a[at] != b[at] {
            return false;
        }
        at += 1;
    }
    true
}

/// The roster, in registry order. A chat is scoped to an entry that opens in itself.
pub const APPS: [RosterApp; 8] = [
    app("agenda", "agenda"),
    app("docs", "docs"),
    card_only("locker"),
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

/// Every id a chat may be scoped to: the apps that open in themselves, but Locker.
pub fn scopes() -> impl Iterator<Item = &'static str> {
    APPS.iter().filter(|app| app.scope).map(|app| app.id)
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
    fn a_scope_is_an_app_that_opens_in_itself_but_for_locker() {
        assert_eq!(
            scopes().collect::<Vec<_>>(),
            ["agenda", "docs", "money", "notes", "people", "photos"]
        );
        assert!(is_card_app("tasks") && !is_scope("tasks"));
        assert!(is_card_app("locker") && !is_scope("locker") && !is_card_app("health"));
        // Every domain opens in an app the roster has, a scope unless it is a card domain only.
        assert!(APPS.iter().all(|app| is_scope(app.opens_in) || !app.scope));
    }
}
