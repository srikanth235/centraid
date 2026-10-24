//! RULES (`money.rules`): a rule matches the bank's own words (is, contains, or
//! a pattern with `*` and `?`) and sets a category; the most specific rule
//! wins. A rule is added, edited and deleted here, and can be applied to the
//! lines already in. Rules never touch a line the member filed or named
//! themselves.
//!
//! AN EDIT SENDS EVERYTHING THE SHEET SHOWS: the pattern, kind, category, and
//! the rule's amount limits and account. A cleared limit or account is sent as
//! null, and an untouched one as its current value. The limits are typed in the
//! units of the account they name; with no account they are typed in the one
//! exponent every account shares, and when there is none the fields are locked
//! and the stored limits go back unchanged. A category or account the page
//! cannot name by its label is left rather than cleared.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use wire::money_rule_editor::Mode;
use wire::money_rules_event::Kind as R;
use wire::money_rules_state::Sheet;
use wire::screen_event::Kind as E;

use super::fold::{self, Phase};
use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::money as money_kit;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

const PATTERN_MAX: usize = 200;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyRules(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Rules {
        parent: args.parent.clone(),
        phase: Phase::Loading,
        sheet: Sheet::None,
        editor: None,
        pending: None,
        status: None,
    }))
}

struct Loaded {
    rules: wire::MoneyRules,
    categories: wire::MoneyCategories,
    accounts: wire::MoneyAccounts,
}

#[derive(Clone, Copy, PartialEq)]
enum Pending {
    Delete,
    Apply,
}

#[derive(Clone)]
struct Editor {
    mode: Mode,
    rule_id: String,
    kind: String,
    pattern: String,
    category_id: String,
    category_label: String,
    account_id: String,
    account_label: String,
    /// A stored limit, for the case where the fields are locked.
    min: Option<i64>,
    max: Option<i64>,
    min_text: String,
    max_text: String,
}

struct Rules {
    parent: String,
    phase: Phase<Loaded>,
    sheet: Sheet,
    editor: Option<Editor>,
    pending: Option<Pending>,
    status: Option<wire::StatusLine>,
}

fn kinds(locale: Locale) -> Vec<(&'static str, String)> {
    vec![
        ("contains", words::kind_contains(locale)),
        ("is", words::kind_is(locale)),
        ("matches", words::kind_matches(locale)),
    ]
}

impl Loaded {
    fn account_lines(&self) -> Vec<&wire::money_accounts::AccountLine> {
        self.accounts
            .on_budget
            .iter()
            .chain(&self.accounts.off_budget)
            .collect()
    }

    /// Each currency's exponent, as the core states it on the amounts the
    /// accounts answer carries. Never guessed: a currency none states has no entry.
    fn exponents(&self) -> BTreeMap<String, u32> {
        let mut seen = BTreeMap::new();
        let mut see = |amount: Option<&wire::MoneyAmount>| {
            if let Some(a) = amount.filter(|a| !a.currency.is_empty()) {
                seen.entry(a.currency.clone()).or_insert(a.exponent);
            }
        };
        for line in self.account_lines() {
            see(line.balance.as_ref());
            if let Some(c) = &line.checkpoint {
                see(c.stated.as_ref());
                see(c.delta.as_ref());
            }
        }
        for net in &self.accounts.net_worth {
            see(net.amount.as_ref());
        }
        seen
    }

    fn limit_accounts(&self, account_id: &str) -> Vec<&wire::money_accounts::AccountLine> {
        self.account_lines()
            .into_iter()
            .filter(|l| account_id.is_empty() || l.account_id == account_id)
            .collect()
    }

    /// The exponent the limits are typed in, or `None` when no one is known:
    /// an account the page cannot name, a currency the answer never states, or
    /// accounts that disagree.
    fn limits_exponent(&self, account_id: &str, account_label: &str) -> Option<u32> {
        if account_id.is_empty() && !account_label.is_empty() {
            return None;
        }
        let table = self.exponents();
        let mut found: Option<u32> = None;
        for line in self.limit_accounts(account_id) {
            let exponent = *table.get(&line.currency)?;
            match found {
                Some(other) if other != exponent => return None,
                _ => found = Some(exponent),
            }
        }
        found
    }

    /// The currency code the limits are in; empty when it is not one currency.
    fn limits_currency(&self, account_id: &str, account_label: &str) -> String {
        if account_id.is_empty() && !account_label.is_empty() {
            return String::new();
        }
        let mut currencies: Vec<&str> = self
            .limit_accounts(account_id)
            .iter()
            .map(|l| l.currency.as_str())
            .collect();
        currencies.dedup();
        match currencies.as_slice() {
            [one] => (*one).to_owned(),
            _ => String::new(),
        }
    }

    fn category_label(&self, id: &str) -> String {
        self.categories
            .groups
            .iter()
            .flat_map(|g| &g.categories)
            .find(|c| c.category_id == id)
            .map(|c| c.label.clone())
            .unwrap_or_default()
    }
}

fn seeded(minor: Option<i64>, exponent: Option<u32>) -> String {
    match (minor, exponent) {
        (Some(minor), Some(exponent)) => money_kit::amount_text(minor, exponent),
        _ => String::new(),
    }
}

/// A typed limit in minor units; `None` when blank, invalid or locked.
fn typed_limit(text: &str, exponent: Option<u32>) -> Option<i64> {
    match exponent {
        Some(exponent) if !text.trim().is_empty() => money_kit::parse(text, exponent),
        _ => None,
    }
}

impl Rules {
    fn reload(&mut self, ctx: &Ctx) {
        use wire::app_query_response::Answer;
        let rules = read::read(ctx, load::money::Rules {}, |a| match a {
            Answer::MoneyRules(x) => Some(x),
            _ => None,
        });
        let categories = read::read(ctx, load::money::Categories {}, |a| match a {
            Answer::MoneyCategories(x) => Some(x),
            _ => None,
        });
        let accounts = read::read(ctx, load::money::Accounts {}, |a| match a {
            Answer::MoneyAccounts(x) => Some(x),
            _ => None,
        });
        self.phase = match (rules, categories, accounts) {
            (Reading::Data(rules), Reading::Data(categories), Reading::Data(accounts)) => {
                Phase::Ready(Loaded {
                    rules,
                    categories,
                    accounts,
                })
            }
            (Reading::Denied(_), ..) => Phase::Denied,
            _ => Phase::Failed,
        };
    }

    fn issue(loaded: &Loaded, editor: &Editor, locale: Locale) -> String {
        let has_effect = !editor.category_label.is_empty() || !editor.category_id.is_empty();
        let exponent = loaded.limits_exponent(&editor.account_id, &editor.account_label);
        let min = typed_limit(&editor.min_text, exponent);
        let max = typed_limit(&editor.max_text, exponent);
        if editor.pattern.trim().is_empty() {
            words::rule_pattern_missing(locale)
        } else if editor.pattern.chars().count() > PATTERN_MAX {
            words::rule_pattern_long(locale)
        } else if !has_effect {
            words::rule_effect_missing(locale)
        } else if exponent.is_some() && !editor.min_text.trim().is_empty() && min.is_none() {
            words::amount_invalid(locale)
        } else if exponent.is_some() && !editor.max_text.trim().is_empty() && max.is_none() {
            words::amount_invalid(locale)
        } else if let (Some(min), Some(max)) = (min, max)
            && min > max
        {
            words::rule_limits_order(locale)
        } else {
            String::new()
        }
    }

    fn submit(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>, done: String) -> bool {
        let key = kit_act::key(&["money", "rule"], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if settled.committed {
            // SAVED, DELETED OR APPLIED: the sheet goes and the list reads again.
            self.sheet = Sheet::None;
            self.editor = None;
            self.status = Some(fold::done(done));
        } else {
            self.status = Some(fold::refusal(ctx.locale(), &settled.refusal));
        }
        self.reload(ctx);
        settled.committed
    }

    fn save(&mut self, ctx: &Ctx) {
        let (Some(editor), Some(loaded)) = (self.editor.clone(), self.phase.data()) else {
            return;
        };
        let locale = ctx.locale();
        if !Self::issue(loaded, &editor, locale).is_empty() {
            return;
        }
        let exponent = loaded.limits_exponent(&editor.account_id, &editor.account_label);
        // A limit as the command takes it: the typed amount, cleared once blank,
        // and while the fields are locked the stored one, so an untouched limit
        // goes back as it is.
        let limit = |text: &str, stored: Option<i64>| -> Field<i64> {
            match exponent {
                None => stored.map_or(Field::Clear, Field::Is),
                Some(_) if text.trim().is_empty() => Field::Clear,
                Some(_) => typed_limit(text, exponent).map_or(Field::Clear, Field::Is),
            }
        };
        let (min, max) = (
            limit(&editor.min_text, editor.min),
            limit(&editor.max_text, editor.max),
        );
        let text = editor.pattern.trim().to_owned();
        if editor.mode == Mode::Add {
            // A NEW RULE'S NO-LIMIT IS AN ABSENT KEY.
            let absent = |f: Field<i64>| match f {
                Field::Is(v) => Field::Is(v),
                _ => Field::Keep,
            };
            self.submit(
                ctx,
                act::money::AddRule {
                    category_id: editor.category_id.clone(),
                    r#match: match editor.kind.as_str() {
                        "is" => act::money::AddRuleMatch::Is,
                        "matches" => act::money::AddRuleMatch::Matches,
                        _ => act::money::AddRuleMatch::Contains,
                    },
                    text,
                    account_id: if editor.account_id.is_empty() {
                        Field::Keep
                    } else {
                        Field::Is(editor.account_id.clone())
                    },
                    min: absent(min),
                    max: absent(max),
                    ..Default::default()
                },
                words::done_rule(locale),
            );
            return;
        }
        // THE SAME FOR THE ACCOUNT: a known one is sent, a cleared one is null,
        // one the page could not name stays.
        let account_id = if !editor.account_id.is_empty() {
            Field::Is(editor.account_id.clone())
        } else if editor.account_label.is_empty() {
            Field::Clear
        } else {
            Field::Keep
        };
        self.submit(
            ctx,
            act::money::EditRule {
                rule_id: editor.rule_id.clone(),
                account_id,
                category_id: Some(editor.category_id.clone()).filter(|c| !c.is_empty()),
                r#match: Some(match editor.kind.as_str() {
                    "is" => act::money::EditRuleMatch::Is,
                    "matches" => act::money::EditRuleMatch::Matches,
                    _ => act::money::EditRuleMatch::Contains,
                }),
                max,
                min,
                text: Some(text),
                ..Default::default()
            },
            words::done_rule(locale),
        );
    }

    fn open_rule(&mut self, rule_id: &str) {
        let Some(loaded) = self.phase.data() else {
            return;
        };
        let Some(rule) = loaded.rules.rules.iter().find(|r| r.rule_id == rule_id) else {
            return;
        };
        // THE RULE NAMES ITS CATEGORY BY LABEL: the id is found by it, and when
        // it cannot be (a renamed or archived one) the category is left alone on save.
        let label = rule.category_label.clone().unwrap_or_default();
        let category_id = if label.is_empty() {
            String::new()
        } else {
            loaded
                .categories
                .groups
                .iter()
                .flat_map(|g| &g.categories)
                .find(|c| c.label == label)
                .map(|c| c.category_id.clone())
                .unwrap_or_default()
        };
        // THE SAME FOR THE ACCOUNT (names are unique): else left alone on save.
        let account_label = rule.account_label.clone().unwrap_or_default();
        let account_id = if account_label.is_empty() {
            String::new()
        } else {
            loaded
                .account_lines()
                .into_iter()
                .find(|l| l.name == account_label)
                .map(|l| l.account_id.clone())
                .unwrap_or_default()
        };
        let exponent = loaded.limits_exponent(&account_id, &account_label);
        self.editor = Some(Editor {
            mode: Mode::Edit,
            rule_id: rule.rule_id.clone(),
            kind: fold::match_kind_key(rule.kind).to_owned(),
            pattern: rule.pattern.clone(),
            category_id,
            category_label: label,
            account_id,
            account_label,
            min: rule.amount_min,
            max: rule.amount_max,
            min_text: seeded(rule.amount_min, exponent),
            max_text: seeded(rule.amount_max, exponent),
        });
        self.sheet = Sheet::Editor;
        self.status = None;
    }

    fn pick_account(&mut self, account_id: &str) {
        let (Some(loaded), Some(editor)) = (self.phase.data(), self.editor.as_mut()) else {
            return;
        };
        let line = loaded
            .account_lines()
            .into_iter()
            .find(|l| l.account_id == account_id);
        if !account_id.is_empty() && line.is_none() {
            return;
        }
        let label = line.map(|l| l.name.clone()).unwrap_or_default();
        let before = loaded.limits_exponent(&editor.account_id, &editor.account_label);
        let after = loaded.limits_exponent(account_id, &label);
        editor.account_id = account_id.to_owned();
        editor.account_label = label;
        // LIMITS THAT WERE LOCKED are in the units of the account the member now
        // names: show them.
        if before.is_none() && after.is_some() {
            editor.min_text = seeded(editor.min, after);
            editor.max_text = seeded(editor.max, after);
        }
        self.sheet = Sheet::Editor;
    }

    fn event(&mut self, event: wire::MoneyRulesEvent, ctx: &Ctx) {
        let locale = ctx.locale();
        match event.kind {
            Some(R::Add(_)) => {
                self.status = None;
                self.sheet = Sheet::Editor;
                self.editor = Some(Editor {
                    mode: Mode::Add,
                    rule_id: String::new(),
                    kind: "contains".to_owned(),
                    pattern: String::new(),
                    category_id: String::new(),
                    category_label: String::new(),
                    account_id: String::new(),
                    account_label: String::new(),
                    min: None,
                    max: None,
                    min_text: String::new(),
                    max_text: String::new(),
                });
            }
            Some(R::Rule(tapped)) => self.open_rule(&tapped.rule_id),
            // The list's own act, or the sheet's own: apply every rule, or this one.
            Some(R::Apply(_)) => self.pending = Some(Pending::Apply),
            Some(R::ConfirmDismissed(_)) => self.pending = None,
            Some(R::ConfirmAccepted(_)) => {
                let editing = self
                    .editor
                    .as_ref()
                    .filter(|e| e.mode == Mode::Edit)
                    .map(|e| e.rule_id.clone());
                match self.pending.take() {
                    Some(Pending::Delete) => {
                        if let Some(rule_id) = editing {
                            self.submit(
                                ctx,
                                act::money::DeleteRule { rule_id },
                                words::done_rule_deleted(locale),
                            );
                        }
                    }
                    Some(Pending::Apply) => {
                        self.submit(
                            ctx,
                            act::money::ApplyRuleToHistory {
                                rule_id: editing,
                                overwrite: None,
                            },
                            words::done_applied(locale),
                        );
                    }
                    None => {}
                }
            }
            Some(R::Delete(_)) if self.editor.as_ref().is_some_and(|e| e.mode == Mode::Edit) => {
                self.pending = Some(Pending::Delete);
            }
            Some(R::Save(_)) => self.save(ctx),
            Some(R::CategorySheet(_)) if self.editor.is_some() => self.sheet = Sheet::Category,
            Some(R::AccountSheet(_)) if self.editor.is_some() => self.sheet = Sheet::Account,
            Some(R::Account(picked)) => self.pick_account(&picked.account_id),
            Some(R::SheetClosed(_)) => {
                self.sheet = if matches!(self.sheet, Sheet::Category | Sheet::Account) {
                    Sheet::Editor
                } else {
                    self.editor = None;
                    Sheet::None
                };
            }
            Some(R::Category(picked)) => {
                let label = self
                    .phase
                    .data()
                    .map(|l| l.category_label(&picked.category_id))
                    .unwrap_or_default();
                if let Some(editor) = self.editor.as_mut() {
                    editor.category_id = picked.category_id;
                    editor.category_label = label;
                    self.sheet = Sheet::Editor;
                }
            }
            other => {
                let Some(editor) = self.editor.as_mut() else {
                    return;
                };
                match other {
                    Some(R::KindPicked(picked)) => editor.kind = picked.kind,
                    Some(R::Pattern(typed)) => editor.pattern = typed.text,
                    Some(R::AmountMin(typed)) => editor.min_text = typed.text,
                    Some(R::AmountMax(typed)) => editor.max_text = typed.text,
                    _ => {}
                }
            }
        }
    }

    fn editor_view(
        &self,
        locale: Locale,
        loaded: &Loaded,
        editor: &Editor,
    ) -> wire::MoneyRuleEditor {
        let add = editor.mode == Mode::Add;
        let issue = Self::issue(loaded, editor, locale);
        let exponent = loaded.limits_exponent(&editor.account_id, &editor.account_label);
        let currency = loaded.limits_currency(&editor.account_id, &editor.account_label);
        let label = |base: String| {
            [base, currency.clone()]
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" · ")
        };
        wire::MoneyRuleEditor {
            mode: editor.mode as i32,
            rule_id: editor.rule_id.clone(),
            kind: editor.kind.clone(),
            pattern: editor.pattern.clone(),
            category_id: editor.category_id.clone(),
            category_label: editor.category_label.clone(),
            account_id: editor.account_id.clone(),
            account_label: editor.account_label.clone(),
            amount_min_text: editor.min_text.clone(),
            amount_max_text: editor.max_text.clone(),
            can_save: issue.is_empty(),
            issue: if editor.pattern.is_empty() && add {
                String::new()
            } else {
                issue
            },
            title: if add {
                words::rule_add_title(locale)
            } else {
                words::rule_edit_title(locale)
            },
            save_label: if add {
                words::rule_add_save(locale)
            } else {
                words::save(locale)
            },
            kind_label: words::rule_when_bank_wrote(locale),
            kind_options: kinds(locale)
                .into_iter()
                .map(|(key, word)| fold::choice(key, &word, key == editor.kind, ""))
                .collect(),
            pattern_label: words::rule_pattern(locale),
            pattern_note: if editor.kind == "matches" {
                words::rule_pattern_wildcard(locale)
            } else {
                words::rule_pattern_note(locale)
            },
            category_row_label: words::rule_set_category(locale),
            delete_label: if add {
                String::new()
            } else {
                words::rule_delete(locale)
            },
            apply_label: if add {
                String::new()
            } else {
                words::rule_apply(locale)
            },
            cancel_label: words::cancel(locale),
            clear_category_label: words::no_category(locale),
            account_row_label: words::rule_account(locale),
            clear_account_label: words::rule_account_any(locale),
            amount_min_label: label(words::rule_amount_min(locale)),
            amount_max_label: label(words::rule_amount_max(locale)),
            limits_enabled: exponent.is_some(),
            amount_note: match exponent {
                None => words::rule_limits_locked_note(locale),
                Some(0) => format!(
                    "{} {}",
                    words::rule_amount_note(locale),
                    words::whole_units(locale)
                ),
                Some(_) => words::rule_amount_note(locale),
            },
        }
    }

    fn data(&self, locale: Locale, loaded: &Loaded) -> wire::MoneyRulesData {
        let rows: Vec<wire::MoneyRuleRow> = loaded
            .rules
            .rules
            .iter()
            .map(|rule| {
                let mut parts = vec![fold::match_kind_word(locale, rule.kind)];
                if let Some(category) = &rule.category_label {
                    parts.push(fill(
                        &words::rule_files_under(locale),
                        &[("category", category)],
                    ));
                }
                if rule.amount_min.is_some() || rule.amount_max.is_some() {
                    parts.push(words::rule_amount_limits(locale));
                }
                if let Some(account) = &rule.account_label {
                    parts.push(fill(&words::rule_only_in(locale), &[("account", account)]));
                }
                let meta = parts.join(" · ");
                wire::MoneyRuleRow {
                    rule_id: rule.rule_id.clone(),
                    title: rule.pattern.clone(),
                    accessibility_label: format!("{}, {meta}", rule.pattern),
                    meta,
                }
            })
            .collect();
        let selected = self
            .editor
            .as_ref()
            .map(|e| e.category_id.clone())
            .unwrap_or_default();
        let chosen_account = self
            .editor
            .as_ref()
            .map(|e| e.account_id.clone())
            .unwrap_or_default();
        let no_label =
            |pick: fn(&Editor) -> &str| self.editor.as_ref().is_none_or(|e| pick(e).is_empty());
        let mut category_options = vec![fold::choice(
            "",
            &words::no_category(locale),
            selected.is_empty() && no_label(|e| &e.category_label),
            "",
        )];
        for group in &loaded.categories.groups {
            for category in group
                .categories
                .iter()
                .filter(|c| !c.archived || c.category_id == selected)
            {
                category_options.push(fold::choice(
                    &category.category_id,
                    &category.label,
                    category.category_id == selected,
                    &group.label,
                ));
            }
        }
        let mut account_options = vec![fold::choice(
            "",
            &words::rule_account_any(locale),
            chosen_account.is_empty() && no_label(|e| &e.account_label),
            "",
        )];
        for line in loaded
            .account_lines()
            .into_iter()
            .filter(|l| !l.closed || l.account_id == chosen_account)
        {
            account_options.push(fold::choice(
                &line.account_id,
                &line.name,
                line.account_id == chosen_account,
                &line.currency,
            ));
        }
        wire::MoneyRulesData {
            limit_line: if rows.is_empty() {
                String::new()
            } else {
                fill(
                    &words::rules_limit(locale),
                    &[
                        ("n", &rows.len().to_string()),
                        ("limit", &loaded.rules.limit.to_string()),
                    ],
                )
            },
            empty: rows.is_empty().then(|| wire::EmptyState {
                headline: words::rules_empty(locale),
                action_label: words::rule_add_save(locale),
                ..Default::default()
            }),
            add_label: words::rule_add_save(locale),
            apply_label: if rows.is_empty() {
                String::new()
            } else {
                words::rules_apply_all(locale)
            },
            rows,
            category_options,
            category_sheet_title: words::category_sheet_title(locale),
            account_options,
            account_sheet_title: words::rule_account_sheet_title(locale),
        }
    }
}

impl Screen for Rules {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneyRules(wire::MoneyRulesEvent {
                kind: Some(wire::money_rules_event::Kind::Refreshed(_)),
            })) => self.reload(ctx),
            Some(E::MoneyRules(r)) => self.event(r, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_rules_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied => Content::Denied(fold::denied(locale)),
            Phase::Ready(loaded) => Content::Data(Box::new(self.data(locale, loaded))),
        };
        let editor = match (&self.phase, &self.editor) {
            (Phase::Ready(loaded), Some(editor)) => Some(self.editor_view(locale, loaded, editor)),
            _ => None,
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyRules(wire::MoneyRulesState {
                content: Some(content),
                sheet: self.sheet as i32,
                editor,
                confirm: self.pending.map(|pending| match pending {
                    Pending::Apply => wire::Confirm {
                        title: words::apply_title(locale),
                        body: words::apply_body(locale),
                        confirm_label: words::apply_confirm(locale),
                        destructive: false,
                    },
                    Pending::Delete => wire::Confirm {
                        title: words::rule_delete_title(locale),
                        body: words::rule_delete_body(locale),
                        confirm_label: words::rule_delete_confirm(locale),
                        destructive: true,
                    },
                }),
                chrome: Some(fold::chrome(
                    locale,
                    words::rules_title(locale),
                    &self.parent,
                )),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
