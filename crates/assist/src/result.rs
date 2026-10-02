//! WHAT A READ ANSWERS: rows to show, and a digest for the model.
//!
//! The model routes and phrases; the apps draw data. So a read's answer is
//! two things at once: **cards** — references to real rows (`app`, `entity`,
//! `id`) that the app's own tile draws and taps through to — and a **digest**,
//! the few lines of text the model sees in order to say one sentence about
//! them. The digest is a deterministic fold of the same rows, truncated by a
//! rule and never by the model.

use crate::tool::App;

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

    /// `title | subtitle | meta`, empty parts skipped.
    fn line(&self) -> String {
        [&self.title, &self.subtitle, &self.meta]
            .into_iter()
            .filter(|part| !part.is_empty())
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" | ")
    }
}

/// One read's answer.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolOutput {
    /// What was found, as one plain sentence: `3 tasks due today`. Also the
    /// deterministic fallback when the model's own phrasing is unusable.
    pub headline: String,
    /// The rows, best first. May exceed [`CARD_CAP`]; the digest says how many.
    pub rows: Vec<Card>,
    /// Facts with no row to draw: a month's category totals, a balance.
    pub facts: Vec<String>,
    /// How many rows exist, when more than `rows` holds.
    pub total: usize,
}

impl ToolOutput {
    /// An answer of rows alone; `total` is their count.
    #[must_use]
    pub fn of_rows(headline: impl Into<String>, rows: Vec<Card>) -> Self {
        let total = rows.len();
        Self {
            headline: headline.into(),
            rows,
            facts: Vec::new(),
            total,
        }
    }

    /// The cards to show.
    #[must_use]
    pub fn cards(&self) -> &[Card] {
        &self.rows[..self.rows.len().min(CARD_CAP)]
    }

    /// The model's view: the headline, the facts, then up to `max_rows` rows,
    /// cut at `max_chars`. Deterministic: the same rows give the same text.
    #[must_use]
    pub fn digest(&self, max_rows: usize, max_chars: usize) -> String {
        let mut lines = vec![self.headline.clone()];
        lines.extend(self.facts.iter().take(8).cloned());
        let shown = self.rows.len().min(max_rows);
        for (at, card) in self.rows[..shown].iter().enumerate() {
            lines.push(format!("{}. {}", at + 1, card.line()));
        }
        let more = self.total.max(self.rows.len()).saturating_sub(shown);
        if more > 0 {
            lines.push(format!("and {more} more"));
        }
        let text = lines.join("\n");
        if text.chars().count() <= max_chars {
            return text;
        }
        let cut: String = text.chars().take(max_chars.saturating_sub(1)).collect();
        format!("{}…", cut.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(n: usize) -> Card {
        Card::new(App::Tasks, "task", format!("t{n}"), format!("Task {n}")).subtitle("2026-10-01")
    }

    #[test]
    fn the_digest_is_the_headline_then_numbered_rows() {
        let out = ToolOutput::of_rows("2 tasks due today", vec![task(1), task(2).meta("overdue")]);
        assert_eq!(
            out.digest(5, 400),
            "2 tasks due today\n1. Task 1 | 2026-10-01\n2. Task 2 | 2026-10-01 | overdue"
        );
    }

    #[test]
    fn rows_past_the_digest_are_counted_not_listed() {
        let rows: Vec<Card> = (1..=9).map(task).collect();
        let out = ToolOutput::of_rows("9 tasks", rows);
        let digest = out.digest(3, 400);
        assert!(digest.contains("3. Task 3"));
        assert!(!digest.contains("4. Task 4"));
        assert!(digest.ends_with("and 6 more"));
    }

    #[test]
    fn a_total_larger_than_the_rows_held_is_honoured() {
        let mut out = ToolOutput::of_rows("many tasks", vec![task(1)]);
        out.total = 40;
        assert!(out.digest(5, 400).ends_with("and 39 more"));
    }

    #[test]
    fn the_digest_is_cut_at_the_character_budget_with_an_ellipsis() {
        let out = ToolOutput::of_rows("x".repeat(100), vec![task(1)]);
        let digest = out.digest(5, 40);
        assert!(digest.chars().count() <= 40);
        assert!(digest.ends_with('…'));
    }

    #[test]
    fn cards_are_capped_to_a_screenful() {
        let rows: Vec<Card> = (1..=20).map(task).collect();
        let out = ToolOutput::of_rows("20 tasks", rows);
        assert_eq!(out.cards().len(), CARD_CAP);
    }

    #[test]
    fn facts_ride_between_the_headline_and_the_rows() {
        let mut out = ToolOutput::of_rows("Spending in 2026-10", Vec::new());
        out.facts = vec!["groceries 112.67 USD".to_owned()];
        assert_eq!(
            out.digest(5, 400),
            "Spending in 2026-10\ngroceries 112.67 USD"
        );
    }
}
