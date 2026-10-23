//! ACCOUNTS (`money.accounts`): the places money sits, each with a balance
//! worked out from its opening amount and every line posted, and a statement's
//! own balance kept only as a checkpoint to compare against. One account, one
//! currency: pounds and dollars stay on separate lines and are never added.
//!
//! THE BANK'S NUMBER IS NEVER SENT BACK: the phone holds only its last four
//! digits, so the number is sent when typed and removed by its own action,
//! which asks first and sends `external_ref: null`. Saving with the field empty
//! keeps the number.

use centraid_api_proto::core_v1 as wire;
use wire::money_account_editor::Mode;
use wire::money_accounts_event::Kind as A;
use wire::money_accounts_state::Sheet;
use wire::screen_event::Kind as E;
use wire::status_chip::Tone;

use super::fold::{self, Phase};
use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

const CURRENCY_LENGTH: usize = 3;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyAccounts(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Accounts {
        parent: args.parent.clone(),
        phase: Phase::Loading,
        editor: None,
        confirm_remove_number: false,
        status: None,
    }))
}

fn kinds(locale: Locale) -> Vec<(&'static str, String)> {
    vec![
        ("checking", words::kind_checking(locale)),
        ("savings", words::kind_savings(locale)),
        ("credit_card", words::kind_credit_card(locale)),
        ("cash", words::kind_cash(locale)),
    ]
}

#[derive(Clone)]
struct Editor {
    mode: Mode,
    account_id: String,
    name: String,
    kind: String,
    currency: String,
    on_budget: bool,
    external_ref: String,
    has_external_ref: bool,
    closed: bool,
}

struct Accounts {
    parent: String,
    phase: Phase<wire::MoneyAccounts>,
    editor: Option<Editor>,
    confirm_remove_number: bool,
    status: Option<wire::StatusLine>,
}

fn lines(answer: &wire::MoneyAccounts) -> Vec<(&wire::money_accounts::AccountLine, bool)> {
    answer
        .on_budget
        .iter()
        .map(|l| (l, true))
        .chain(answer.off_budget.iter().map(|l| (l, false)))
        .collect()
}

impl Accounts {
    fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(read::read(ctx, load::money::Accounts {}, |a| match a {
            wire::app_query_response::Answer::MoneyAccounts(x) => Some(x),
            _ => None,
        }));
    }

    fn issue(editor: &Editor, locale: Locale) -> String {
        if editor.name.trim().is_empty() {
            words::account_name_missing(locale)
        } else if editor.mode == Mode::Add
            && !editor.currency.is_empty()
            && (editor.currency.chars().count() != CURRENCY_LENGTH
                || !editor.currency.chars().all(|c| c.is_ascii_uppercase()))
        {
            words::account_currency_invalid(locale)
        } else {
            String::new()
        }
    }

    fn submit(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>) -> bool {
        let key = kit_act::key(&["money", "account"], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            self.status = Some(fold::refusal(ctx.locale(), &settled.refusal));
        }
        settled.committed
    }

    fn save(&mut self, ctx: &Ctx) {
        let Some(editor) = self.editor.clone() else {
            return;
        };
        let locale = ctx.locale();
        if !Self::issue(&editor, locale).is_empty() {
            return;
        }
        let number = Some(editor.external_ref.trim().to_owned()).filter(|n| !n.is_empty());
        let committed = if editor.mode == Mode::Add {
            self.submit(
                ctx,
                act::money::AddAccount {
                    title: editor.name.trim().to_owned(),
                    r#type: match editor.kind.as_str() {
                        "savings" => act::money::AddAccountType::Savings,
                        "credit_card" => act::money::AddAccountType::CreditCard,
                        "cash" => act::money::AddAccountType::Cash,
                        _ => act::money::AddAccountType::Checking,
                    },
                    currency: Some(editor.currency.clone()).filter(|c| !c.is_empty()),
                    external_ref: number,
                    on_budget: Some(editor.on_budget),
                    ..Default::default()
                },
            )
        } else {
            let before_closed = self
                .phase
                .data()
                .and_then(|answer| {
                    lines(answer)
                        .into_iter()
                        .find(|(l, _)| l.account_id == editor.account_id)
                        .map(|(l, _)| l.closed)
                })
                .unwrap_or(editor.closed);
            let edited = self.submit(
                ctx,
                act::money::EditAccount {
                    account_id: editor.account_id.clone(),
                    external_ref: number.map_or(Field::Keep, Field::Is),
                    on_budget: Some(editor.on_budget),
                    title: Some(editor.name.trim().to_owned()),
                    r#type: Some(match editor.kind.as_str() {
                        "savings" => act::money::EditAccountType::Savings,
                        "credit_card" => act::money::EditAccountType::CreditCard,
                        "cash" => act::money::EditAccountType::Cash,
                        _ => act::money::EditAccountType::Checking,
                    }),
                },
            );
            // A closed account is the archived flag on it: its own action, sent beside the edit.
            if edited && before_closed != editor.closed {
                if editor.closed {
                    self.submit(
                        ctx,
                        act::money::CloseAccount {
                            flag: act::money::CloseAccountFlag::Archived,
                            account_id: editor.account_id.clone(),
                        },
                    )
                } else {
                    self.submit(
                        ctx,
                        act::money::ReopenAccount {
                            flag: act::money::ReopenAccountFlag::Archived,
                            account_id: editor.account_id.clone(),
                        },
                    )
                }
            } else {
                edited
            }
        };
        if committed {
            self.editor = None;
            self.status = Some(fold::done(words::done_account(locale)));
        }
        self.reload(ctx);
    }

    fn remove_number(&mut self, ctx: &Ctx) {
        self.confirm_remove_number = false;
        let Some(editor) = self.editor.clone() else {
            return;
        };
        // ONLY THE NUMBER: the rest of the sheet is unsaved typing, and stays unsent.
        if self.submit(
            ctx,
            act::money::EditAccount {
                account_id: editor.account_id,
                external_ref: Field::Clear,
                ..Default::default()
            },
        ) {
            self.editor = None;
            self.status = Some(fold::done(words::account_number_removed(ctx.locale())));
        }
        self.reload(ctx);
    }

    fn event(&mut self, event: wire::MoneyAccountsEvent, ctx: &Ctx) {
        match event.kind {
            Some(A::Add(_)) => {
                self.status = None;
                self.editor = Some(Editor {
                    mode: Mode::Add,
                    account_id: String::new(),
                    name: String::new(),
                    kind: "checking".to_owned(),
                    currency: String::new(),
                    on_budget: true,
                    external_ref: String::new(),
                    has_external_ref: false,
                    closed: false,
                });
            }
            Some(A::Account(tapped)) => {
                let Some(answer) = self.phase.data() else {
                    return;
                };
                let Some((line, on_budget)) = lines(answer)
                    .into_iter()
                    .find(|(l, _)| l.account_id == tapped.account_id)
                else {
                    return;
                };
                self.editor = Some(Editor {
                    mode: Mode::Edit,
                    account_id: line.account_id.clone(),
                    name: line.name.clone(),
                    kind: line.kind.clone(),
                    currency: line.currency.clone(),
                    on_budget,
                    external_ref: String::new(),
                    has_external_ref: line.mask.is_some(),
                    closed: line.closed,
                });
                self.status = None;
            }
            Some(A::ConfirmDismissed(_)) => self.confirm_remove_number = false,
            Some(A::ConfirmAccepted(_)) if self.confirm_remove_number => self.remove_number(ctx),
            Some(A::SheetClosed(_)) => self.editor = None,
            Some(A::Save(_)) => self.save(ctx),
            other => {
                let Some(editor) = self.editor.as_mut() else {
                    return;
                };
                match other {
                    // ASK FIRST: removing the number is the one edit the member cannot see to undo.
                    Some(A::RemoveNumber(_))
                        if editor.mode == Mode::Edit && editor.has_external_ref =>
                    {
                        self.confirm_remove_number = true;
                    }
                    Some(A::Name(typed)) => editor.name = typed.text,
                    Some(A::KindPicked(picked)) => editor.kind = picked.kind,
                    Some(A::Currency(typed)) => {
                        editor.currency = typed
                            .text
                            .to_uppercase()
                            .chars()
                            .take(CURRENCY_LENGTH)
                            .collect();
                    }
                    Some(A::OnBudget(_)) => editor.on_budget = !editor.on_budget,
                    Some(A::ExternalRef(typed)) => editor.external_ref = typed.text,
                    Some(A::Closed(_)) => editor.closed = !editor.closed,
                    _ => {}
                }
            }
        }
    }

    fn editor_view(&self, locale: Locale, editor: &Editor) -> wire::MoneyAccountEditor {
        let add = editor.mode == Mode::Add;
        let issue = Self::issue(editor, locale);
        let removable = !add && editor.has_external_ref;
        wire::MoneyAccountEditor {
            mode: editor.mode as i32,
            account_id: editor.account_id.clone(),
            name: editor.name.clone(),
            kind: editor.kind.clone(),
            currency: editor.currency.clone(),
            on_budget: editor.on_budget,
            external_ref: editor.external_ref.clone(),
            has_external_ref: editor.has_external_ref,
            closed: editor.closed,
            can_save: issue.is_empty(),
            // an untouched blank name is not yet an error
            issue: if editor.name.is_empty() && add {
                String::new()
            } else {
                issue
            },
            title: if add {
                words::account_add_title(locale)
            } else {
                words::account_edit_title(locale)
            },
            save_label: if add {
                words::account_add_save(locale)
            } else {
                words::save(locale)
            },
            name_label: words::account_name(locale),
            kind_label: words::account_kind(locale),
            kind_options: kinds(locale)
                .into_iter()
                .map(|(key, label)| fold::choice(key, &label, key == editor.kind, ""))
                .collect(),
            currency_label: if add {
                words::account_currency(locale)
            } else {
                String::new()
            },
            on_budget_label: words::account_on_budget(locale),
            external_ref_label: words::account_number(locale),
            external_ref_note: if add {
                words::account_number_note(locale)
            } else {
                words::account_number_edit_note(locale)
            },
            closed_label: if add {
                String::new()
            } else {
                words::account_closed(locale)
            },
            cancel_label: words::cancel(locale),
            remove_number_label: if removable {
                words::account_remove_number(locale)
            } else {
                String::new()
            },
            can_remove_number: removable,
        }
    }

    fn data(locale: Locale, answer: &wire::MoneyAccounts) -> wire::MoneyAccountsData {
        let row = |line: &wire::money_accounts::AccountLine| {
            let checkpoint = line.checkpoint.as_ref();
            let kind_word = kinds(locale)
                .into_iter()
                .find(|(k, _)| *k == line.kind)
                .map(|(_, w)| w)
                .unwrap_or_default();
            let meta = [
                line.mask.as_ref().map(|m| format!("····{m}")),
                Some(kind_word).filter(|w| !w.is_empty()),
                Some(line.currency.clone()),
                line.closed.then(|| words::account_closed_meta(locale)),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
            let (checkpoint_line, tone) = match checkpoint {
                None => (words::checkpoint_none(locale), Tone::Seam),
                Some(c) if c.agrees => (
                    fill(
                        &words::checkpoint_matches(locale),
                        &[("day", &fold::day_short(locale, &c.as_of))],
                    ),
                    Tone::Neutral,
                ),
                Some(c) => (
                    fill(
                        &words::checkpoint_off(locale),
                        &[("day", &fold::day_short(locale, &c.as_of))],
                    ),
                    Tone::Warning,
                ),
            };
            wire::MoneyAccountRow {
                account_id: line.account_id.clone(),
                name: line.name.clone(),
                has_balance: line.balance.is_some(),
                balance: fold::text(line.balance.as_ref()),
                balance_note: if line.balance.is_none() {
                    words::balance_unknown(locale)
                } else {
                    String::new()
                },
                has_delta: checkpoint.is_some_and(|c| !c.agrees),
                delta: fold::text(checkpoint.and_then(|c| c.delta.as_ref())),
                checkpoint_tone: tone as i32,
                accessibility_label: [line.name.clone(), meta.clone(), checkpoint_line.clone()]
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join(", "),
                checkpoint_line,
                meta,
            }
        };
        let mut sections = Vec::new();
        if !answer.on_budget.is_empty() {
            sections.push(wire::MoneyAccountSection {
                title: words::on_budget(locale),
                rows: answer.on_budget.iter().map(row).collect(),
            });
        }
        if !answer.off_budget.is_empty() {
            sections.push(wire::MoneyAccountSection {
                title: words::off_budget(locale),
                rows: answer.off_budget.iter().map(row).collect(),
            });
        }
        wire::MoneyAccountsData {
            net_worth_label: if answer.net_worth.is_empty() {
                String::new()
            } else {
                words::net_worth(locale)
            },
            net_worth: answer
                .net_worth
                .iter()
                .map(|line| {
                    let currency = line.amount.as_ref().map_or("", |a| a.currency.as_str());
                    fold::figure(
                        &if line.complete {
                            currency.to_owned()
                        } else {
                            format!("{currency} · {}", words::incomplete(locale))
                        },
                        line.amount.as_ref(),
                        fold::sign_tone(line.amount.as_ref()),
                    )
                })
                .collect(),
            net_worth_note: if answer.net_worth.len() > 1 {
                words::net_worth_note(locale)
            } else {
                String::new()
            },
            empty: sections.is_empty().then(|| wire::EmptyState {
                headline: words::accounts_empty(locale),
                action_label: words::add_account(locale),
                ..Default::default()
            }),
            sections,
            add_label: words::add_account(locale),
            definitions: fold::definitions(locale, &answer.definitions),
        }
    }
}

impl Screen for Accounts {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneyAccounts(a)) => self.event(a, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_accounts_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied => Content::Denied(fold::denied(locale)),
            Phase::Ready(answer) => Content::Data(Box::new(Self::data(locale, answer))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyAccounts(
                wire::MoneyAccountsState {
                    content: Some(content),
                    sheet: if self.editor.is_some() {
                        Sheet::Editor
                    } else {
                        Sheet::None
                    } as i32,
                    editor: self.editor.as_ref().map(|e| self.editor_view(locale, e)),
                    confirm: self.confirm_remove_number.then(|| wire::Confirm {
                        title: words::account_remove_number_title(locale),
                        body: words::account_remove_number_body(locale),
                        confirm_label: words::account_remove_number_confirm(locale),
                        destructive: true,
                    }),
                    chrome: Some(fold::chrome(
                        locale,
                        words::accounts_title(locale),
                        &self.parent,
                    )),
                    status: self.status.clone(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
