//! THE APPS THE ASSISTANT READS: seven, and Locker is not one of them. (Tally left with
//! the app and Money joined, #1099.)
//!
//! [`App`] has no `Locker` variant, so no card can name it and no chat can be scoped to it. A
//! secret that was never in a prompt cannot be in an answer (R-1088-3).
//!
//! A CARD NAMES A DOMAIN; A CHAT IS SCOPED TO AN APP (R-1128-F2, #1128). `Tasks` is a domain —
//! a card, a search hit and a write say `tasks` — that opens in Agenda, so it is no chat scope:
//! [`App::SCOPES`] leaves it out, [`App::scope_from_id`] refuses `tasks`, and a chat scoped to
//! Agenda covers task rows as well as events ([`App::covers`]).

/// An app the assistant can read. Locker is deliberately absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum App {
    Agenda,
    Docs,
    Money,
    Notes,
    People,
    Photos,
    Tasks,
}

impl App {
    /// Every app, in registry order.
    pub const ALL: [Self; 7] = [
        Self::Agenda,
        Self::Docs,
        Self::Money,
        Self::Notes,
        Self::People,
        Self::Photos,
        Self::Tasks,
    ];

    /// The id a shell routes by — the same word `AppRegistry` uses.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Agenda => "agenda",
            Self::Docs => "docs",
            Self::Money => "money",
            Self::Notes => "notes",
            Self::People => "people",
            Self::Photos => "photos",
            Self::Tasks => "tasks",
        }
    }

    /// THE APP A MEMBER OPENS THIS DOMAIN IN (R-1128-D1). `id` is the domain a card, a chat scope
    /// and a search hit are stored and routed by, and `Tasks` stays that domain; but the Tasks
    /// app is folded into Agenda (#1128), so a member never opens "Tasks". Every place the
    /// assistant NAMES an app to the member (the activity line "Looking in Agenda", a name on a
    /// screen) goes through here; every place it STORES or ROUTES an id keeps `id()`.
    #[must_use]
    pub const fn opens_in(self) -> Self {
        match self {
            Self::Tasks => Self::Agenda,
            other => other,
        }
    }

    /// THE APPS A CHAT CAN BE SCOPED TO (R-1128-F2): every app a member opens, which is every
    /// domain that opens in itself. `Tasks` opens in Agenda, so it is not one; the vault's
    /// `chat_thread.scope_app` CHECK holds the same six (`contracts/migrations/002_*`).
    pub const SCOPES: [Self; 6] = [
        Self::Agenda,
        Self::Docs,
        Self::Money,
        Self::Notes,
        Self::People,
        Self::Photos,
    ];

    /// Whether a chat can be scoped to this app: it opens in itself (R-1128-F2).
    #[must_use]
    pub fn is_scope(self) -> bool {
        self.opens_in() == self
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
            Self::Money => "Money",
            Self::Notes => "Notes",
            Self::People => "People",
            Self::Photos => "Photos",
            Self::Tasks => "Agenda",
        }
    }

    /// The app a shell named, or `None` — which includes `locker`.
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.id() == id)
    }

    /// The chat scope a shell named, or `None` — which includes `locker` and `tasks`: a domain
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
    fn locker_is_in_no_scope() {
        assert!(App::from_id("locker").is_none());
        assert!(App::ALL.iter().all(|app| app.id() != "locker"));
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
        // SCOPES is exactly the apps that open in themselves, in registry order.
        let opened: Vec<App> = App::ALL.into_iter().filter(|app| app.is_scope()).collect();
        assert_eq!(opened, App::SCOPES);
        // `tasks` is a domain and a card app, never a scope (R-1128-F2).
        assert_eq!(App::scope_from_id("tasks"), None);
        assert_eq!(App::scope_from_id("locker"), None);
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
