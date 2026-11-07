//! THE CUSTOM REPEAT SHEET (#1173 wave 2), for a task and an event alike.
//!
//! The sheet edits a WORKING rule ([`Custom`]), not the draft: every change
//! re-derives the rule and the sentence that says it, and Done writes the rule
//! to the draft only when it is whole. Closing the sheet drops the working rule,
//! so a half-built one never reaches a save.
//!
//! An existing rule the sheet can represent opens in it. One it cannot (an
//! import's `BYSETPOS`, say) opens READ-ONLY: its sentence is shown with one
//! choice, to replace it, because opening a different rule than the stored one
//! would change the member's calendar without asking.

use centraid_api_proto::core_v1 as wire;

use super::Editor;
use super::draft::{self, Draft, REPEAT_CUSTOM, RULES};
use super::fields::choice;
use super::repeat::{
    self, End, Freq, LAST_DAY, MAX_COUNT, MAX_INTERVAL, MonthMode, ORDINALS, Problem, Spec,
    WEEKDAYS,
};
use crate::agenda::event::long_day;
use crate::agenda::rule_words::{self, weekday_full};
use crate::kit::civil;
use crate::strings::agenda_repeat as words;
use crate::strings::{Locale, agenda as day_words};
use centraid_vault::time::Freq as VaultFreq;
use centraid_vault::time::rrule::{DAY_TOKENS, DayRule, RuleShape, ShapeEnd};
use wire::agenda_editor_state::Sheet;

/// What the open sheet holds.
#[derive(Clone, Debug)]
pub struct Custom {
    pub spec: Spec,
    /// The stored rule cannot be shown part by part.
    pub read_only: bool,
}

fn weekday_short(locale: Locale, token: &str) -> String {
    match token {
        "MO" => day_words::weekday_mon(locale),
        "TU" => day_words::weekday_tue(locale),
        "WE" => day_words::weekday_wed(locale),
        "TH" => day_words::weekday_thu(locale),
        "FR" => day_words::weekday_fri(locale),
        "SA" => day_words::weekday_sat(locale),
        _ => day_words::weekday_sun(locale),
    }
}

fn ordinal_word(locale: Locale, ordinal: i32) -> String {
    match ordinal {
        1 => words::ordinal_first(locale),
        2 => words::ordinal_second(locale),
        3 => words::ordinal_third(locale),
        4 => words::ordinal_fourth(locale),
        _ => words::ordinal_last(locale),
    }
}

/// The vault's structural view of what the sheet holds: the same shape a
/// stored rule has, so the sheet and a stored rule say ONE wording
/// ([`rule_words::sentence`]).
fn shape_of(spec: &Spec) -> RuleShape {
    let day_index = |token: &str| {
        DAY_TOKENS
            .iter()
            .position(|candidate| *candidate == token)
            .and_then(|at| u8::try_from(at).ok())
            .unwrap_or(0)
    };
    let mut weekdays: Vec<DayRule> = Vec::new();
    let mut month_days: Vec<i64> = Vec::new();
    match (spec.freq, spec.month_mode) {
        (Freq::Weekly, _) => {
            weekdays = spec
                .sorted_weekdays()
                .iter()
                .map(|day| DayRule {
                    ordinal: None,
                    day: day_index(day),
                })
                .collect();
        }
        (Freq::Monthly, MonthMode::Date) => {
            month_days = spec
                .sorted_month_days()
                .iter()
                .map(|day| i64::from(*day))
                .collect();
        }
        (Freq::Monthly, MonthMode::Nth) => {
            weekdays = vec![DayRule {
                ordinal: Some(i64::from(spec.ordinal)),
                day: day_index(spec.nth_day),
            }];
        }
        _ => {}
    }
    let end = match spec.end {
        End::Never => ShapeEnd::Never,
        End::On => civil::epoch_day_of(&spec.until_day)
            .and_then(|_| {
                let mut parts = spec.until_day.split('-');
                Some(ShapeEnd::Until {
                    year: parts.next()?.parse().ok()?,
                    month: parts.next()?.parse().ok()?,
                    day: parts.next()?.parse().ok()?,
                })
            })
            .unwrap_or(ShapeEnd::Never),
        End::After => ShapeEnd::Count(i64::from(spec.count.max(1))),
    };
    RuleShape {
        freq: match spec.freq {
            Freq::Daily => VaultFreq::Daily,
            Freq::Weekly => VaultFreq::Weekly,
            Freq::Monthly => VaultFreq::Monthly,
            Freq::Yearly => VaultFreq::Yearly,
        },
        interval: i64::from(spec.interval.max(1)),
        weekdays,
        month_days,
        year_days: Vec::new(),
        week_numbers: Vec::new(),
        months: Vec::new(),
        set_positions: Vec::new(),
        end,
    }
}

/// THE SENTENCE THE RULE SAYS: "Every 2 weeks on Monday and Friday, until
/// Thursday 31 December". The same words a stored rule is read in.
#[must_use]
pub fn summary(locale: Locale, spec: &Spec) -> String {
    rule_words::sentence(locale, &shape_of(spec))
}

/// The sentence a problem says.
fn problem_sentence(locale: Locale, problem: Problem) -> String {
    match problem {
        Problem::Interval => words::error_interval(locale),
        Problem::Weekday => words::error_weekday(locale),
        Problem::MonthDay => words::error_month_day(locale),
        Problem::Until => words::error_until(locale),
        Problem::UntilBefore => words::error_until_before(locale),
        Problem::Count => words::error_count(locale),
        Problem::Rule => words::error_rule(locale),
    }
}

impl Editor {
    /// Open the sheet over the draft's rule, or over a fresh weekly one.
    pub(super) fn open_custom(&mut self) {
        let Some(draft) = &self.draft else { return };
        let start = draft.start_day.clone();
        let custom = match draft::rule_for(draft) {
            Some(rule) => match repeat::from_rrule(&rule, &start) {
                Some(spec) => Custom {
                    spec,
                    read_only: false,
                },
                None => Custom {
                    spec: Spec::starting(&start),
                    read_only: true,
                },
            },
            None => Custom {
                spec: Spec::starting(&start),
                read_only: false,
            },
        };
        self.close_sheet();
        self.sheet = Sheet::CustomRepeat;
        self.custom = Some(custom);
    }

    /// The working spec, when the sheet is open and editable.
    fn spec_mut(&mut self) -> Option<&mut Spec> {
        self.custom
            .as_mut()
            .filter(|custom| !custom.read_only)
            .map(|custom| &mut custom.spec)
    }

    pub(super) fn custom_freq(&mut self, key: &str) {
        if let (Some(freq), Some(spec)) = (Freq::of_key(key), self.spec_mut()) {
            spec.freq = freq;
        }
    }

    pub(super) fn custom_interval(&mut self, interval: i32) {
        if let Some(spec) = self.spec_mut() {
            // A value out of range is kept, so the sheet can say why it is not a rule.
            spec.interval = interval.clamp(0, MAX_INTERVAL + 1);
        }
    }

    pub(super) fn custom_weekday(&mut self, key: &str) {
        let Some(token) = WEEKDAYS.iter().find(|day| **day == key).copied() else {
            return;
        };
        if let Some(spec) = self.spec_mut() {
            if let Some(at) = spec.weekdays.iter().position(|day| *day == token) {
                spec.weekdays.remove(at);
            } else {
                spec.weekdays.push(token);
            }
        }
    }

    pub(super) fn custom_month_mode(&mut self, key: &str) {
        if let (Some(mode), Some(spec)) = (MonthMode::of_key(key), self.spec_mut()) {
            spec.month_mode = mode;
        }
    }

    pub(super) fn custom_month_day(&mut self, key: &str) {
        let Some(day) = key
            .parse::<i32>()
            .ok()
            .filter(|day| (1..=31).contains(day) || *day == LAST_DAY)
        else {
            return;
        };
        if let Some(spec) = self.spec_mut() {
            if let Some(at) = spec.month_days.iter().position(|d| *d == day) {
                spec.month_days.remove(at);
            } else {
                spec.month_days.push(day);
            }
        }
    }

    pub(super) fn custom_ordinal(&mut self, key: &str) {
        if let Some(ordinal) = key.parse::<i32>().ok().filter(|n| ORDINALS.contains(n))
            && let Some(spec) = self.spec_mut()
        {
            spec.ordinal = ordinal;
        }
    }

    pub(super) fn custom_nth_weekday(&mut self, key: &str) {
        if let (Some(token), Some(spec)) = (
            WEEKDAYS.iter().find(|day| **day == key).copied(),
            self.spec_mut(),
        ) {
            spec.nth_day = token;
        }
    }

    pub(super) fn custom_end(&mut self, key: &str) {
        if let (Some(end), Some(spec)) = (End::of_key(key), self.spec_mut()) {
            spec.end = end;
        }
    }

    pub(super) fn custom_until(&mut self, day: &str) {
        if civil::epoch_day_of(day).is_none() {
            return;
        }
        if let Some(spec) = self.spec_mut() {
            spec.until_day = day.to_owned();
        }
    }

    pub(super) fn custom_count(&mut self, count: i32) {
        if let Some(spec) = self.spec_mut() {
            spec.count = count.clamp(0, MAX_COUNT + 1);
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
        if let Some(custom) = self.custom.as_mut().filter(|custom| custom.read_only) {
            custom.spec = Spec::starting(&start);
            custom.read_only = false;
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
        let Ok(rule) = repeat::to_rrule(&custom.spec, &draft.start_day) else {
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
        let spec = &custom.spec;
        if custom.read_only {
            let summary = self
                .event()
                .and_then(|event| event.rrule.as_deref())
                .and_then(|rule| rule_words::of_rule(locale, rule))
                .filter(|_| draft::same_repeat(draft, self.baseline.as_ref().unwrap_or(draft)))
                .unwrap_or_else(|| words::unrepresentable(locale));
            return Some(wire::AgendaCustomRepeatSheet {
                title: words::title(locale),
                read_only: true,
                replace_label: words::replace(locale),
                summary,
                done_label: words::done(locale),
                can_apply: true,
                ..wire::AgendaCustomRepeatSheet::default()
            });
        }
        let checked = spec.check(&draft.start_day);
        let steps = u64::try_from(spec.interval.max(1)).unwrap_or(1);
        let unit = match spec.freq {
            Freq::Daily => words::unit_days(locale, steps),
            Freq::Weekly => words::unit_weeks(locale, steps),
            Freq::Monthly => words::unit_months(locale, steps),
            Freq::Yearly => words::unit_years(locale, steps),
        };
        let freq_label = |freq: Freq| match freq {
            Freq::Daily => words::freq_daily(locale),
            Freq::Weekly => words::freq_weekly(locale),
            Freq::Monthly => words::freq_monthly(locale),
            Freq::Yearly => words::freq_yearly(locale),
        };
        let monthly = spec.monthly();
        let weekday_choices = |selected: &dyn Fn(&str) -> bool| -> Vec<wire::AgendaChoice> {
            WEEKDAYS
                .iter()
                .map(|day| wire::AgendaChoice {
                    accessibility_label: weekday_full(locale, day),
                    ..choice(day, &weekday_short(locale, day), selected(day))
                })
                .collect()
        };
        Some(wire::AgendaCustomRepeatSheet {
            title: words::title(locale),
            read_only: false,
            replace_label: String::new(),
            summary: if checked.is_ok() {
                summary(locale, spec)
            } else {
                String::new()
            },
            error: checked
                .err()
                .map(|problem| problem_sentence(locale, problem))
                .unwrap_or_default(),
            can_apply: checked.is_ok(),
            done_label: words::done(locale),
            frequencies: Freq::ALL
                .iter()
                .map(|freq| choice(freq.key(), &freq_label(*freq), *freq == spec.freq))
                .collect(),
            frequency_label: words::frequency_label(locale),
            interval_label: words::interval_label(locale),
            interval: spec.interval,
            unit_label: unit,
            show_weekdays: spec.weekly(),
            weekdays_label: words::weekdays_label(locale),
            weekdays: weekday_choices(&|day| spec.weekdays.contains(&day)),
            show_month_modes: monthly,
            month_modes: vec![
                choice(
                    MonthMode::Date.key(),
                    &words::mode_date(locale),
                    spec.month_mode == MonthMode::Date,
                ),
                choice(
                    MonthMode::Nth.key(),
                    &words::mode_nth(locale),
                    spec.month_mode == MonthMode::Nth,
                ),
            ],
            show_month_days: monthly && spec.month_mode == MonthMode::Date,
            month_days_label: words::month_days_label(locale),
            month_days: (1..=31)
                .chain(std::iter::once(LAST_DAY))
                .map(|day| {
                    let label = if day == LAST_DAY {
                        words::last_day(locale)
                    } else {
                        day.to_string()
                    };
                    choice(&day.to_string(), &label, spec.month_days.contains(&day))
                })
                .collect(),
            show_nth: monthly && spec.month_mode == MonthMode::Nth,
            ordinals: ORDINALS
                .iter()
                .map(|ordinal| {
                    choice(
                        &ordinal.to_string(),
                        &ordinal_word(locale, *ordinal),
                        *ordinal == spec.ordinal,
                    )
                })
                .collect(),
            nth_weekdays: weekday_choices(&|day| spec.nth_day == day),
            ends_label: words::ends_label(locale),
            end_modes: End::ALL
                .iter()
                .map(|end| {
                    let label = match end {
                        End::Never => words::end_never(locale),
                        End::On => words::end_on(locale),
                        End::After => words::end_after(locale),
                    };
                    choice(end.key(), &label, *end == spec.end)
                })
                .collect(),
            show_until: spec.end == End::On,
            until_day: spec.until_day.clone(),
            until_day_label: if civil::epoch_day_of(&spec.until_day).is_some() {
                long_day(locale, &spec.until_day)
            } else {
                String::new()
            },
            show_count: spec.end == End::After,
            count: spec.count,
            count_label: words::count_label(locale, u64::try_from(spec.count.max(1)).unwrap_or(1)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ONE WORDING (owner decision, #1173): the sentence the sheet builds from
    /// its spec is the sentence a stored rule says, for every rule the sheet
    /// can show.
    #[test]
    fn the_sheet_and_a_stored_rule_say_the_same_words() {
        for rule in [
            "FREQ=DAILY",
            "FREQ=DAILY;INTERVAL=3;COUNT=5",
            "FREQ=WEEKLY;BYDAY=MO,FR",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=2030-12-31",
            "FREQ=MONTHLY;BYMONTHDAY=1,15,-1",
            "FREQ=MONTHLY;INTERVAL=2;BYDAY=2MO",
            "FREQ=MONTHLY;BYDAY=-1FR;COUNT=1",
            "FREQ=YEARLY",
        ] {
            let spec = repeat::from_rrule(rule, "2026-06-10").expect("the sheet shows it");
            assert_eq!(
                summary(Locale::En, &spec),
                rule_words::of_rule(Locale::En, rule).expect("words"),
                "{rule}"
            );
        }
    }
}
