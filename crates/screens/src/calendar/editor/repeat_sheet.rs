//! THE CUSTOM REPEAT SHEET, AS THE EVENT EDITOR HOLDS IT: [`Custom`] is the kit's
//! (`kit::schedule::custom`); this is the editor's side of it, opening it over the draft's rule and
//! writing the rule it finishes with back to the draft.

use centraid_api_proto::core_v1 as wire;

use super::Editor;
use super::draft::{self, Draft, REPEAT_CUSTOM, RULES};
use crate::kit::schedule::custom::Custom;
use crate::kit::schedule::rule_words;
use crate::strings::Locale;
use crate::strings::agenda_repeat as words;
use wire::agenda_editor_state::Sheet;

impl Editor {
    /// Open the sheet over the draft's rule, or over a fresh weekly one.
    pub(super) fn open_custom(&mut self) {
        let Some(draft) = &self.draft else { return };
        let custom = Custom::open(draft::rule_for(draft).as_deref(), &draft.start_day);
        self.close_sheet();
        self.sheet = Sheet::CustomRepeat;
        self.custom = Some(custom);
    }

    pub(super) fn custom_freq(&mut self, key: &str) {
        if let Some(custom) = &mut self.custom {
            custom.freq(key);
        }
    }

    pub(super) fn custom_interval(&mut self, interval: i32) {
        if let Some(custom) = &mut self.custom {
            custom.interval(interval);
        }
    }

    pub(super) fn custom_weekday(&mut self, key: &str) {
        if let Some(custom) = &mut self.custom {
            custom.weekday(key);
        }
    }

    pub(super) fn custom_month_mode(&mut self, key: &str) {
        if let Some(custom) = &mut self.custom {
            custom.month_mode(key);
        }
    }

    pub(super) fn custom_month_day(&mut self, key: &str) {
        if let Some(custom) = &mut self.custom {
            custom.month_day(key);
        }
    }

    pub(super) fn custom_ordinal(&mut self, key: &str) {
        if let Some(custom) = &mut self.custom {
            custom.ordinal(key);
        }
    }

    pub(super) fn custom_nth_weekday(&mut self, key: &str) {
        if let Some(custom) = &mut self.custom {
            custom.nth_weekday(key);
        }
    }

    pub(super) fn custom_end(&mut self, key: &str) {
        if let Some(custom) = &mut self.custom {
            custom.end(key);
        }
    }

    pub(super) fn custom_until(&mut self, day: &str) {
        if let Some(custom) = &mut self.custom {
            custom.until(day);
        }
    }

    pub(super) fn custom_count(&mut self, count: i32) {
        if let Some(custom) = &mut self.custom {
            custom.count(count);
        }
    }

    /// "Replace this rule": the stored rule the sheet could not show gives way
    /// to a fresh weekly one.
    pub(super) fn replace_custom(&mut self) {
        let start = self
            .draft
            .as_ref()
            .map(|draft| draft.start_day.clone())
            .unwrap_or_default();
        if let Some(custom) = &mut self.custom {
            custom.replace(&start);
        }
    }

    /// Done. A whole rule goes to the draft and the sheet closes; a read-only
    /// sheet just closes, leaving the stored rule as it was.
    pub(super) fn apply_custom(&mut self) {
        let Some(custom) = self.custom.clone() else {
            return;
        };
        let Some(draft) = &self.draft else { return };
        if custom.read_only {
            self.close_sheet();
            return;
        }
        let Some(rule) = custom.rule(&draft.start_day) else {
            return;
        };
        // A rule that is one of the presets is that preset.
        let preset = RULES
            .iter()
            .find(|(_, preset)| {
                draft::same_repeat(
                    &Draft {
                        repeat_key: REPEAT_CUSTOM.to_owned(),
                        repeat_rule: (*preset).to_owned(),
                        ..Draft::default()
                    },
                    &Draft {
                        repeat_key: REPEAT_CUSTOM.to_owned(),
                        repeat_rule: rule.clone(),
                        ..Draft::default()
                    },
                )
            })
            .map(|(key, _)| (*key).to_owned());
        self.close_sheet();
        self.edit(|d| {
            Some(Draft {
                repeat_key: preset.clone().unwrap_or_else(|| REPEAT_CUSTOM.to_owned()),
                repeat_rule: if preset.is_some() {
                    String::new()
                } else {
                    rule.clone()
                },
                ..d.clone()
            })
        });
    }

    /// The sheet the view draws, while it is open.
    pub(super) fn custom_sheet(
        &self,
        locale: Locale,
        draft: &Draft,
    ) -> Option<wire::AgendaCustomRepeatSheet> {
        let custom = self.custom.as_ref()?;
        Some(custom.sheet(locale, &draft.start_day, || {
            self.event()
                .and_then(|event| event.rrule.as_deref())
                .and_then(|rule| rule_words::of_rule(locale, rule))
                .filter(|_| draft::same_repeat(draft, self.baseline.as_ref().unwrap_or(draft)))
                .unwrap_or_else(|| words::unrepresentable(locale))
        }))
    }
}
