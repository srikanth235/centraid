//! THE APPS THE ASSISTANT READS: seven, and Locker is not one of them.
//!
//! [`App`] has no `Locker` variant, so no card can name it and no chat can be scoped to it. A
//! secret that was never in a prompt cannot be in an answer (R-1088-3).

/// An app the assistant can read. Locker is deliberately absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum App {
    Agenda,
    Docs,
    Notes,
    People,
    Photos,
    Tally,
    Tasks,
}

impl App {
    /// Every app, in registry order.
    pub const ALL: [Self; 7] = [
        Self::Agenda,
        Self::Docs,
        Self::Notes,
        Self::People,
        Self::Photos,
        Self::Tally,
        Self::Tasks,
    ];

    /// The id a shell routes by — the same word `AppRegistry` uses.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Agenda => "agenda",
            Self::Docs => "docs",
            Self::Notes => "notes",
            Self::People => "people",
            Self::Photos => "photos",
            Self::Tally => "tally",
            Self::Tasks => "tasks",
        }
    }

    /// The app's name as a member reads it ("Looking in Tally").
    #[must_use]
    pub const fn display(self) -> &'static str {
        match self {
            Self::Agenda => "Agenda",
            Self::Docs => "Docs",
            Self::Notes => "Notes",
            Self::People => "People",
            Self::Photos => "Photos",
            Self::Tally => "Tally",
            Self::Tasks => "Tasks",
        }
    }

    /// The app a shell named, or `None` — which includes `locker`.
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.id() == id)
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
            assert_eq!(app.display().to_lowercase(), app.id());
        }
        assert_eq!(App::from_id("TALLY"), None, "ids are the shell's, exactly");
    }
}
