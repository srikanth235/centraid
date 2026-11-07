//! THE QUICK ADD'S KEYBOARD TOOLBAR (#1173): Date, Tag and Flag over the
//! keyboard, on To-do's home and on a project page.
//!
//! Each tool STAGES what the next add carries; Return adds the task with it,
//! clears the title and the staging, and leaves the field focused so the next
//! one can be typed at once. Date and Tag open a tray (the due choices, a tag
//! field); Flag is a switch with no tray. Link and Photo, which the board draws,
//! have nothing to attach to yet, so they are not here.

use centraid_api_proto::core_v1 as wire;

use crate::agenda::detail::{self, NEXT_WEEK, NONE, TODAY, TOMORROW, WEEKEND};
use crate::strings::{Locale, agenda_tasks as words, task};

/// `TodoQuickTool.key`s.
pub const DATE: &str = "date";
pub const TAG: &str = "tag";
pub const FLAG: &str = "flag";

const DUE_KEYS: [&str; 4] = [TODAY, TOMORROW, WEEKEND, NEXT_WEEK];

/// What the next add carries, and the tray that is open.
#[derive(Clone, Debug, Default)]
pub struct Quick {
    /// A `detail` due key (`today`, `tomorrow`, …), or empty for no date.
    due: String,
    /// Tags as typed, without the `#`, in order.
    tags: Vec<String>,
    flagged: bool,
    /// The tool whose tray is open: [`DATE`], [`TAG`] or empty.
    open: String,
}

impl Quick {
    /// A key of the toolbar: Date and Tag open their tray (a second press
    /// closes it); Flag flips the flag. Anything else is nothing.
    pub fn pick_tool(&mut self, key: &str) {
        match key {
            DATE | TAG => {
                self.open = if self.open == key {
                    String::new()
                } else {
                    key.to_owned()
                };
            }
            FLAG => {
                self.flagged = !self.flagged;
                self.open.clear();
            }
            _ => {}
        }
    }

    /// A due choice: a day key stages it, `none` clears it; the tray closes.
    pub fn pick_due(&mut self, key: &str) {
        if key == NONE {
            self.due.clear();
        } else if DUE_KEYS.contains(&key) {
            self.due = key.to_owned();
        } else {
            return;
        }
        self.open.clear();
    }

    /// A tag typed in the tray: trimmed, a leading `#` dropped, and a tag
    /// already staged (in any case) is not staged twice. The tray stays open
    /// for the next one.
    pub fn add_tag(&mut self, text: &str) {
        let tag = text.trim().trim_start_matches('#').trim();
        if tag.is_empty() || self.tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            return;
        }
        self.tags.push(tag.to_owned());
    }

    /// The add committed: nothing is staged and no tray is open.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// The staged due as a day from the core's `today`, or empty for none.
    #[must_use]
    pub fn due_day(&self, today: &str) -> String {
        detail::day_for(&self.due, today).unwrap_or_default()
    }

    #[must_use]
    pub fn tags(&self) -> &[String] {
        &self.tags
    }

    #[must_use]
    pub fn flagged(&self) -> bool {
        self.flagged
    }

    #[must_use]
    pub fn staged(&self) -> bool {
        !self.due.is_empty() || !self.tags.is_empty() || self.flagged
    }

    /// "Tomorrow · #errand · Flagged"; empty when nothing is staged.
    #[must_use]
    pub fn staged_label(&self, locale: Locale) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !self.due.is_empty() {
            parts.push(due_label(locale, &self.due));
        }
        parts.extend(self.tags.iter().map(|tag| format!("#{tag}")));
        if self.flagged {
            parts.push(words::quick_flagged(locale));
        }
        parts.join(" · ")
    }

    fn tools(&self, locale: Locale) -> Vec<wire::TodoQuickTool> {
        [
            (
                DATE,
                words::quick_date(locale),
                "Calendar",
                !self.due.is_empty(),
            ),
            (TAG, words::quick_tag(locale), "Tag", !self.tags.is_empty()),
            (FLAG, words::quick_flag(locale), "Flag", self.flagged),
        ]
        .into_iter()
        .map(|(key, label, icon, on)| wire::TodoQuickTool {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            on,
        })
        .collect()
    }

    fn due_choices(&self, locale: Locale) -> Vec<wire::TodoChoice> {
        DUE_KEYS
            .iter()
            .map(|key| (*key, self.due == *key))
            .chain(std::iter::once((NONE, self.due.is_empty())))
            .map(|(key, selected)| wire::TodoChoice {
                key: key.to_owned(),
                label: due_label(locale, key),
                selected,
                enabled: true,
                ..wire::TodoChoice::default()
            })
            .collect()
    }

    /// Draw the toolbar's half of a quick add.
    pub fn fill(&self, locale: Locale, quick: &mut wire::TodoQuickAdd) {
        quick.tools = self.tools(locale);
        quick.staged_label = self.staged_label(locale);
        quick.open_tool.clone_from(&self.open);
        quick.due_choices = if self.open == DATE {
            self.due_choices(locale)
        } else {
            Vec::new()
        };
        quick.tag_placeholder = task::tags_add(locale);
    }
}

fn due_label(locale: Locale, key: &str) -> String {
    match key {
        TODAY => task::when_today(locale),
        TOMORROW => task::when_tomorrow(locale),
        WEEKEND => task::when_weekend(locale),
        NEXT_WEEK => task::when_next_week(locale),
        _ => task::when_none(locale),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    #[test]
    fn date_and_tag_toggle_their_tray_and_flag_is_a_switch() {
        let mut quick = Quick::default();
        quick.pick_tool(DATE);
        assert_eq!(quick.open, DATE);
        quick.pick_tool(TAG);
        assert_eq!(quick.open, TAG, "one tray at a time");
        quick.pick_tool(TAG);
        assert!(quick.open.is_empty());
        quick.pick_tool(FLAG);
        assert!(quick.flagged() && quick.open.is_empty());
        quick.pick_tool(FLAG);
        assert!(!quick.flagged());
        quick.pick_tool("photo");
        assert!(!quick.staged());
    }

    #[test]
    fn a_due_choice_stages_and_closes_the_tray_and_an_unknown_key_is_nothing() {
        let mut quick = Quick::default();
        quick.pick_tool(DATE);
        quick.pick_due("later");
        assert_eq!(quick.open, DATE);
        assert!(!quick.staged());
        quick.pick_due(TOMORROW);
        assert!(quick.open.is_empty());
        assert_eq!(quick.due_day("2026-11-07"), "2026-11-08");
        quick.pick_due(NONE);
        assert_eq!(quick.due_day("2026-11-07"), "");
    }

    #[test]
    fn tags_are_trimmed_and_deduped_in_any_case_and_the_label_joins_what_is_staged() {
        let mut quick = Quick::default();
        for tag in [" #Errand ", "errand", "", "  ", "home"] {
            quick.add_tag(tag);
        }
        assert_eq!(quick.tags(), ["Errand".to_owned(), "home".to_owned()]);
        quick.pick_due(TOMORROW);
        quick.pick_tool(FLAG);
        assert_eq!(
            quick.staged_label(EN),
            "Tomorrow · #Errand · #home · Flagged"
        );
        quick.clear();
        assert_eq!(quick.staged_label(EN), "");
    }
}
