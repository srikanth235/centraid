//! THE RESULT CARD: a reference to one real row.
//!
//! The model writes calls; the apps draw data. So a turn's rows reach the shell as
//! **cards** — references to real rows (`app`, `entity`, `id`) that the app's own tile
//! draws and taps through to, with just enough words to name them. The line beside them is
//! composed by the runtime from the same rows (`native_turn`).

use crate::app::App;

/// How many cards one answer shows. A screenful, not a list: past this the
/// answer says "and N more" and the member opens the app.
pub const CARD_CAP: usize = 6;

/// A reference to one real row, with just enough to name it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub app: App,
    /// What the row is, in the app's own vocabulary: `task`, `event`, `person`…
    pub entity: &'static str,
    pub id: String,
    /// A second key the app's route takes beside `id` (a repeating event's
    /// instance); empty when there is none.
    pub qualifier: String,
    pub title: String,
    pub subtitle: String,
    pub meta: String,
}

impl Card {
    /// A card with no qualifier and no secondary text.
    #[must_use]
    pub fn new(
        app: App,
        entity: &'static str,
        id: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            app,
            entity,
            id: id.into(),
            qualifier: String::new(),
            title: title.into(),
            subtitle: String::new(),
            meta: String::new(),
        }
    }

    #[must_use]
    pub fn subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = subtitle.into();
        self
    }

    #[must_use]
    pub fn meta(mut self, meta: impl Into<String>) -> Self {
        self.meta = meta.into();
        self
    }

    #[must_use]
    pub fn qualifier(mut self, qualifier: impl Into<String>) -> Self {
        self.qualifier = qualifier.into();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_is_a_reference_with_words_to_name_it() {
        let card = Card::new(App::Tasks, "task", "t1", "Pick up the dry cleaning")
            .subtitle("2026-10-01")
            .meta("overdue")
            .qualifier("2026-10-08");
        assert_eq!(
            (
                card.app,
                card.entity,
                card.id.as_str(),
                card.title.as_str(),
                card.subtitle.as_str(),
                card.meta.as_str(),
                card.qualifier.as_str()
            ),
            (
                App::Tasks,
                "task",
                "t1",
                "Pick up the dry cleaning",
                "2026-10-01",
                "overdue",
                "2026-10-08"
            )
        );
        let bare = Card::new(App::Notes, "note", "n1", "Trip");
        assert!(bare.subtitle.is_empty() && bare.meta.is_empty() && bare.qualifier.is_empty());
    }
}
