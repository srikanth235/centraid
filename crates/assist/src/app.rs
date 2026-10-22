//! THE APPS THE ASSISTANT READS: eight, seven of them chat scopes. (Tally left with the app and
//! Money joined, #1099; Locker joined by the owner's ruling of 2026-10-22, #1135.)
//!
//! The roster is the vault's one constant (`centraid_vault::roster::APPS`, R-1135-7-1): [`App`]
//! is its typed face, and its id and its `opens_in` are *indexed out of that constant* by the
//! variant's position, so a word is never spelled twice. A test holds the variants and the
//! roster to the same order and the same names.
//!
//! A card may name [`App::Locker`] (a Locker item's title opens its page behind the lock wall) and
//! a chat may be scoped to it like any app. What the assistant has of a Locker item is the owner's
//! access to its plain rows; a sealed value was never in a prompt and cannot be in an answer
//! (R-1088-3).
//!
//! A CARD NAMES A DOMAIN; A CHAT IS SCOPED TO AN APP (R-1128-F2, #1128). `Tasks` is a domain —
//! a card, a search hit and a write say `tasks` — that opens in Agenda, so it is no chat scope:
//! [`App::SCOPES`] leaves it out, [`App::scope_from_id`] refuses `tasks`, and a chat scoped to
//! Agenda covers task rows as well as events ([`App::covers`]).

use centraid_vault::roster;

/// An app the assistant can read. The variants are in the order of
/// `roster::APPS`, which `id` and `opens_in` index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum App {
    Agenda,
    Docs,
    Locker,
    Money,
    Notes,
    People,
    Photos,
    Tasks,
}

impl App {
    /// Every app, in registry order.
    pub const ALL: [Self; 8] = [
        Self::Agenda,
        Self::Docs,
        Self::Locker,
        Self::Money,
        Self::Notes,
        Self::People,
        Self::Photos,
        Self::Tasks,
    ];

    /// The id a shell routes by — the same word `AppRegistry` uses.
    #[must_use]
    pub const fn id(self) -> &'static str {
        roster::APPS[self as usize].id
    }

    /// THE APP A MEMBER OPENS THIS DOMAIN IN (R-1128-D1). `id` is the domain a card, a chat scope
    /// and a search hit are stored and routed by, and `Tasks` stays that domain; but the Tasks
    /// app is folded into Agenda (#1128), so a member never opens "Tasks". Every place the
    /// assistant NAMES an app to the member (the activity line "Looking in Agenda", a name on a
    /// screen) goes through here; every place it STORES or ROUTES an id keeps `id()`.
    #[must_use]
    pub fn opens_in(self) -> Self {
        let opens_in = roster::APPS[self as usize].opens_in;
        Self::from_id(opens_in).unwrap_or(self)
    }

    /// THE APPS A CHAT CAN BE SCOPED TO (R-1128-F2): every app a member opens, which is every
    /// domain that opens in itself. `Tasks` opens in Agenda, so it is not one; the vault's
    /// `thread.save_turn` schema holds the same seven (`roster::scopes`).
    pub const SCOPES: [Self; 7] = [
        Self::Agenda,
        Self::Docs,
        Self::Locker,
        Self::Money,
        Self::Notes,
        Self::People,
        Self::Photos,
    ];

    /// Whether a chat can be scoped to this app: it opens in itself (R-1128-F2).
    #[must_use]
    pub fn is_scope(self) -> bool {
        roster::APPS[self as usize].scope
    }

    /// THE DOMAINS A CHAT SCOPED TO THIS APP READS, in registry order: every domain that opens
    /// in the same app. Agenda covers Agenda and Tasks; every other app covers itself
    /// (R-1128-F2, #1128).
    pub fn covers(self) -> impl Iterator<Item = Self> {
        let app = self.opens_in();
        Self::ALL
            .into_iter()
            .filter(move |domain| domain.opens_in() == app)
    }

    /// The app's name as a member reads it ("Looking in Notes"): the name of the app the domain
    /// opens in, so `Tasks` reads "Agenda" (R-1128-D1).
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
            Self::Tasks => "Agenda",
        }
    }

    /// The app a shell named, or `None`.
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.id() == id)
    }

    /// The chat scope a shell named, or `None` — which includes `tasks`: a domain
    /// that opens in another app is read through that app's scope, never named as one of its
    /// own, so a thread has exactly one name for "Agenda" (R-1128-F2).
    #[must_use]
    pub fn scope_from_id(id: &str) -> Option<Self> {
        Self::SCOPES.into_iter().find(|app| app.id() == id)
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
        assert_eq!(
            App::SCOPES.map(App::id).to_vec(),
            roster::scopes().collect::<Vec<_>>()
        );
        for (position, app) in App::ALL.into_iter().enumerate() {
            assert_eq!(app as usize, position, "{app:?} is indexed by its position");
            assert_eq!(app.opens_in().id(), roster::APPS[position].opens_in);
        }
    }

    #[test]
    fn locker_is_a_card_domain_and_a_scope() {
        assert_eq!(App::from_id("locker"), Some(App::Locker));
        assert_eq!(App::Locker.display(), "Locker");
        assert!(App::Locker.is_scope());
        assert!(App::SCOPES.contains(&App::Locker));
    }

    #[test]
    fn every_app_round_trips_through_its_id_and_reads_as_a_name() {
        let mut seen = std::collections::BTreeSet::new();
        for app in App::ALL {
            assert_eq!(App::from_id(app.id()), Some(app));
            assert!(seen.insert(app.id()), "{}", app.id());
            // The name a member reads is the name of the app the domain opens in, not of the
            // domain: it equals the id for every app but Tasks, which opens in Agenda (#1128).
            assert_eq!(app.display().to_lowercase(), app.opens_in().id());
        }
        assert_eq!(App::from_id("NOTES"), None, "ids are the shell's, exactly");
    }

    #[test]
    fn tasks_is_a_domain_a_member_opens_in_agenda() {
        // The id is stored and routed (card app, search app_id, write app) and does not move.
        assert_eq!(App::Tasks.id(), "tasks");
        assert_eq!(App::from_id("tasks"), Some(App::Tasks));
        assert_eq!(App::Tasks.opens_in(), App::Agenda);
        assert_eq!(App::Tasks.display(), "Agenda");
        // Every other app opens in itself, and an app that opens in another is a domain only.
        for app in App::ALL.into_iter().filter(|app| *app != App::Tasks) {
            assert_eq!(app.opens_in(), app, "{}", app.id());
        }
        assert!(
            App::ALL
                .iter()
                .all(|app| app.opens_in().opens_in() == app.opens_in())
        );
    }

    #[test]
    fn a_scope_is_an_app_a_member_opens_and_agenda_covers_tasks() {
        // SCOPES is exactly the apps a chat can be scoped to, in registry order.
        let opened: Vec<App> = App::ALL.into_iter().filter(|app| app.is_scope()).collect();
        assert_eq!(opened, App::SCOPES);
        // `tasks` is a domain and a card app, never a scope (R-1128-F2).
        assert_eq!(App::scope_from_id("tasks"), None);
        assert_eq!(App::scope_from_id("locker"), Some(App::Locker));
        assert_eq!(App::scope_from_id("agenda"), Some(App::Agenda));
        for app in App::SCOPES {
            assert_eq!(App::scope_from_id(app.id()), Some(app));
        }
        // Agenda's scope reads events and tasks; every other scope reads itself.
        assert_eq!(
            App::Agenda.covers().collect::<Vec<_>>(),
            [App::Agenda, App::Tasks]
        );
        for app in App::SCOPES.into_iter().filter(|app| *app != App::Agenda) {
            assert_eq!(app.covers().collect::<Vec<_>>(), [app], "{}", app.id());
        }
        // Every domain is covered by exactly one scope.
        for domain in App::ALL {
            let covering = App::SCOPES
                .into_iter()
                .filter(|scope| scope.covers().any(|covered| covered == domain))
                .count();
            assert_eq!(covering, 1, "{}", domain.id());
        }
    }
}
