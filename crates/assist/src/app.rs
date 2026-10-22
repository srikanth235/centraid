//! THE APPS THE ASSISTANT READS: seven, every one a chat scope. (Tally left with the app and Money
//! joined, #1099; Locker joined by the owner's ruling of 2026-10-22, #1135; Tasks were folded into
//! Agenda, #1128.)
//!
//! The roster is the vault's one constant (`centraid_vault::roster::APPS`, R-1135-7-1): [`App`]
//! is its typed face, and its id is *indexed out of that constant* by the variant's position, so a
//! word is never spelled twice. A test holds the variants and the roster to the same order and the
//! same names.
//!
//! A card may name [`App::Locker`] (a Locker item's title opens its page behind the lock wall) and
//! a chat may be scoped to it like any app. What the assistant has of a Locker item is the owner's
//! access to its plain rows; a sealed value was never in a prompt and cannot be in an answer
//! (R-1088-3).
//!
//! ONE APP IS ONE WORD. A card, a search hit, a write and a chat scope all name the app the member
//! opens: the tasks a member keeps are Agenda's, so a task card says `agenda`, and nothing maps
//! one app onto another.

use centraid_vault::roster;

/// An app the assistant can read. The variants are in the order of `roster::APPS`, which `id`
/// indexes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum App {
    Agenda,
    Docs,
    Locker,
    Money,
    Notes,
    People,
    Photos,
}

impl App {
    /// Every app, in registry order. A chat can be scoped to any of them.
    pub const ALL: [Self; 7] = [
        Self::Agenda,
        Self::Docs,
        Self::Locker,
        Self::Money,
        Self::Notes,
        Self::People,
        Self::Photos,
    ];

    /// The id a shell routes by — the same word `AppRegistry` uses.
    #[must_use]
    pub const fn id(self) -> &'static str {
        roster::APPS[self as usize].id
    }

    /// The app's name as a member reads it ("Looking in Notes").
    #[must_use]
    pub const fn display(self) -> &'static str {
        match self {
            Self::Agenda => "Agenda",
            Self::Docs => "Docs",
            Self::Locker => "Locker",
            Self::Money => "Money",
            Self::Notes => "Notes",
            Self::People => "People",
            Self::Photos => "Photos",
        }
    }

    /// The app a shell named, or `None`.
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.id() == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_variants_are_the_vaults_roster_in_its_order() {
        assert_eq!(
            App::ALL.map(App::id),
            roster::APPS.map(|app| app.id),
            "App::ALL and roster::APPS list the same apps in the same order"
        );
        for (position, app) in App::ALL.into_iter().enumerate() {
            assert_eq!(app as usize, position, "{app:?} is indexed by its position");
        }
    }

    #[test]
    fn locker_is_a_card_domain_and_a_scope() {
        assert_eq!(App::from_id("locker"), Some(App::Locker));
        assert_eq!(App::Locker.display(), "Locker");
    }

    #[test]
    fn every_app_round_trips_through_its_id_and_reads_as_a_name() {
        let mut seen = std::collections::BTreeSet::new();
        for app in App::ALL {
            assert_eq!(App::from_id(app.id()), Some(app));
            assert!(seen.insert(app.id()), "{}", app.id());
            assert_eq!(app.display().to_lowercase(), app.id());
        }
        assert_eq!(App::from_id("NOTES"), None, "ids are the shell's, exactly");
    }

    #[test]
    fn there_is_no_tasks_app() {
        assert_eq!(App::from_id("tasks"), None);
    }
}
