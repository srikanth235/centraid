//! IMPORT A STATEMENT (`money.import`): pick a file, read the plan, publish.
//! Nothing is written until the last button.
//!
//! The file's bytes are held here while the core plans them and are dropped
//! when the page is left, on Start over, and once the rows are in: statement
//! bytes are never stored, and a view carries rows and sentences only. The plan
//! is the core's (`import-plan`); a CSV needs its account, an OFX file finds its
//! own. The plan can ask one question (a date order the file cannot answer) and
//! offer one override (which sign means money out); each answer plans the same
//! file again. A row proposed as a duplicate is skipped unless the member says
//! otherwise.
//!
//! PUBLISHING IS THE ORDINARY ACTION, `import-transactions`, with the plan's own
//! `publish_input` unchanged, one statement at a time; the balance a statement
//! stated and a CSV's layout are remembered only after every one committed.

use centraid_api_proto::core_v1 as wire;
use wire::money_import_event::Kind as I;
use wire::money_import_state::{Phase as P, Sheet};
use wire::screen_event::Kind as E;
use wire::status_chip::Tone;

use super::fold::{self, Phase, chip, choice};
use crate::catalog::act::money as acts;
use crate::catalog::load::money as loads;
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

/// Rows of each kind drawn under a statement; the rest are counted.
const SHOWN_ROWS: usize = 25;
const SHOWN_NEW: usize = 10;
/// How much of a file is read to tell an OFX file by its header.
const SNIFF: usize = 256;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyImport(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Import {
        parent: args.parent.clone(),
        accounts: Phase::Loading,
        file: None,
        account_id: String::new(),
        date_order: None,
        sign: None,
        keep_proposed: false,
        phase: P::Idle,
        plan: None,
        status: None,
        sheet: Sheet::None,
        finished: false,
    }))
}

/// The file as picked. Never leaves this screen and is emptied once its rows
/// are in.
struct Held {
    name: String,
    bytes: Vec<u8>,
}

struct Import {
    parent: String,
    accounts: Phase<wire::MoneyAccounts>,
    file: Option<Held>,
    account_id: String,
    date_order: Option<loads::ImportPlanDateOrder>,
    sign: Option<loads::ImportPlanSign>,
    keep_proposed: bool,
    phase: P,
    plan: Option<wire::MoneyImportPlan>,
    status: Option<wire::StatusLine>,
    sheet: Sheet,
    finished: bool,
}

/// An OFX or QFX file by its name or its first bytes, else a CSV.
fn source_of(file: &Held) -> loads::ImportPlanSource {
    let name = file.name.to_lowercase();
    if name.ends_with(".ofx") || name.ends_with(".qfx") {
        return loads::ImportPlanSource::Ofx;
    }
    let head: String = file
        .bytes
        .iter()
        .take(SNIFF)
        .map(|byte| char::from(*byte))
        .collect::<String>()
        .to_uppercase();
    if head.contains("OFXHEADER") || head.contains("<OFX>") {
        loads::ImportPlanSource::Ofx
    } else {
        loads::ImportPlanSource::Csv
    }
}

impl Import {
    fn open_accounts(&self) -> Vec<&wire::money_accounts::AccountLine> {
        self.accounts.data().map_or_else(Vec::new, |accounts| {
            accounts
                .on_budget
                .iter()
                .chain(&accounts.off_budget)
                .filter(|line| !line.closed)
                .collect()
        })
    }

    fn reload_accounts(&mut self, ctx: &Ctx) {
        self.accounts = Phase::of(read::read(ctx, loads::Accounts {}, |a| match a {
            wire::app_query_response::Answer::MoneyAccounts(x) => Some(x),
            _ => None,
        }));
    }

    /// Drop the file and the plan, and every answer given about them.
    fn drop_file(&mut self) {
        self.file = None;
        self.plan = None;
        self.date_order = None;
        self.sign = None;
        self.keep_proposed = false;
        self.sheet = Sheet::None;
        self.phase = P::Idle;
    }

    fn picked(&mut self, ctx: &Ctx, file: wire::BytesPicked) {
        if file.cancelled || self.phase == P::Publishing {
            return;
        }
        // THE ONLY ACCOUNT IS THE ACCOUNT: a vault with one has nothing to ask.
        let account = if self.account_id.is_empty() {
            match self.open_accounts().as_slice() {
                [only] => only.account_id.clone(),
                _ => String::new(),
            }
        } else {
            self.account_id.clone()
        };
        self.drop_file();
        self.status = None;
        self.account_id = account;
        self.file = Some(Held {
            name: file.name,
            bytes: file.content,
        });
        self.plan_again(ctx);
    }

    /// Plan the held file again with the answers given so far, or wait for the
    /// account a CSV needs.
    fn plan_again(&mut self, ctx: &Ctx) {
        let Some(file) = &self.file else {
            return;
        };
        let source = source_of(file);
        let locale = ctx.locale();
        if source == loads::ImportPlanSource::Csv && self.account_id.is_empty() {
            self.plan = None;
            self.phase = P::Idle;
            self.status = Some(fold::done(words::import_choose_account(locale)));
            return;
        }
        let reading = read::read(
            ctx,
            loads::ImportPlan {
                content: file.bytes.clone(),
                source,
                account_id: Some(self.account_id.clone()).filter(|id| !id.is_empty()),
                date_order: self.date_order,
                sign: self.sign,
            },
            |a| match a {
                wire::app_query_response::Answer::MoneyImportPlan(x) => Some(x),
                _ => None,
            },
        );
        match reading {
            read::Reading::Data(plan) => {
                self.plan = Some(plan);
                self.phase = P::Planned;
                self.status = None;
            }
            read::Reading::Denied(_) | read::Reading::Failed => {
                self.plan = None;
                self.phase = P::Idle;
                self.status = Some(fold::refusal(locale, &words::no_answer(locale)));
            }
        }
    }

    /// The input a publish sends for each statement, in order.
    fn inputs(&self) -> Vec<Vec<u8>> {
        self.plan
            .iter()
            .flat_map(|plan| &plan.statements)
            .filter_map(|statement| {
                let with = &statement.publish_input_with_proposed;
                let chosen = if self.keep_proposed && !with.is_empty() {
                    with
                } else {
                    &statement.publish_input
                };
                (!chosen.is_empty()).then(|| chosen.clone())
            })
            .collect()
    }

    /// Rows an Import would write: what the plan counts as new, plus the rows
    /// proposed as duplicates when the member keeps them. A statement that asks
    /// a question, or has nothing to send under the chosen input, writes none.
    fn publishable(&self) -> u32 {
        self.plan
            .iter()
            .flat_map(|plan| &plan.statements)
            .fold(0, |sum, statement| {
                let with = &statement.publish_input_with_proposed;
                let chosen = if self.keep_proposed && !with.is_empty() {
                    with
                } else {
                    &statement.publish_input
                };
                if statement.question.is_some() || chosen.is_empty() {
                    sum
                } else {
                    sum + statement.new
                        + if self.keep_proposed {
                            statement.proposed_duplicates
                        } else {
                            0
                        }
                }
            })
    }

    fn publish(&mut self, ctx: &Ctx) {
        let locale = ctx.locale();
        let inputs = self.inputs();
        if inputs.is_empty() {
            return;
        }
        // A NEW GESTURE, A NEW KEY: a retry after a refusal is not a replay.
        let seq = kit_act::fresh();
        for (index, input) in inputs.iter().enumerate() {
            let Some(request) = import_request(input) else {
                self.refused(locale, "");
                return;
            };
            let key = kit_act::key(&["import-transactions", &index.to_string()], seq);
            let settled = kit_act::act(ctx, request, &key);
            if !settled.committed {
                // A REFUSED PUBLISH KEEPS THE PLAN, so Import can be tried
                // again: rows already in write nothing.
                self.refused(locale, &settled.refusal);
                return;
            }
        }
        let written = self.written();
        self.remember(ctx, seq);
        if let Some(file) = &mut self.file {
            file.bytes = Vec::new();
        }
        self.phase = P::Published;
        self.status = Some(fold::done(fill(
            &words::import_done(locale),
            &[(
                "rows",
                &fold::count(
                    written as usize,
                    &words::row_one(locale),
                    &words::row_many(locale),
                ),
            )],
        )));
    }

    fn refused(&mut self, locale: Locale, sentence: &str) {
        self.phase = P::Planned;
        self.status = Some(fold::refusal(
            locale,
            if sentence.trim().is_empty() {
                words::import_failed(locale)
            } else {
                sentence.to_owned()
            }
            .as_str(),
        ));
    }

    /// Rows a publish wrote, as the plan counted them.
    fn written(&self) -> u32 {
        self.plan
            .iter()
            .flat_map(|plan| &plan.statements)
            .map(|statement| {
                statement.new
                    + if self.keep_proposed {
                        statement.proposed_duplicates
                    } else {
                        0
                    }
            })
            .sum()
    }

    /// The balance each statement stated, and the layout a CSV used: each its
    /// own action, after the rows. Neither can take the import back.
    fn remember(&self, ctx: &Ctx, seq: u64) {
        let statements = self.plan.iter().flat_map(|plan| &plan.statements);
        for statement in statements {
            let Some(account) = &statement.account_id else {
                continue;
            };
            if let Some(stated) = &statement.checkpoint
                && let Some(balance) = &stated.balance
            {
                let key = kit_act::key(&["record-checkpoint", account, &stated.as_of], seq);
                let _ = kit_act::act(
                    ctx,
                    acts::RecordCheckpoint {
                        account_id: account.clone(),
                        balance_minor: balance.minor,
                        day: stated.as_of.clone(),
                    },
                    &key,
                );
            }
            if let Some(profile) = &statement.profile_to_save {
                let key = kit_act::key(&["save-import-profile", account], seq);
                let _ = kit_act::act(
                    ctx,
                    acts::SaveImportProfile {
                        account_id: account.clone(),
                        layout: layout_json(profile),
                    },
                    &key,
                );
            }
        }
    }

    fn event(&mut self, event: wire::MoneyImportEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let busy = self.phase == P::Publishing;
        match event.kind {
            Some(I::Choose(_)) if !busy => {
                return vec![wire::Effect {
                    kind: Some(wire::effect::Kind::PickBytes(wire::PickBytes {
                        accept: vec![
                            "text/csv".to_owned(),
                            "application/x-ofx".to_owned(),
                            ".ofx".to_owned(),
                            ".qfx".to_owned(),
                        ],
                    })),
                }];
            }
            Some(I::AccountSheetOpened(_)) if !busy => self.sheet = Sheet::Account,
            Some(I::SheetClosed(_)) => self.sheet = Sheet::None,
            Some(I::AccountPicked(picked)) if !busy => {
                self.account_id = picked.account_id;
                self.sheet = Sheet::None;
                self.plan_again(ctx);
            }
            Some(I::DateOrder(answer)) if !busy => {
                self.date_order = match answer.order.as_str() {
                    "mdy" => Some(loads::ImportPlanDateOrder::Mdy),
                    "dmy" => Some(loads::ImportPlanDateOrder::Dmy),
                    _ => self.date_order,
                };
                self.plan_again(ctx);
            }
            Some(I::Sign(answer)) if !busy => {
                self.sign = match answer.choice.as_str() {
                    "debits_negative" => Some(loads::ImportPlanSign::DebitsNegative),
                    "debits_positive" => Some(loads::ImportPlanSign::DebitsPositive),
                    _ => self.sign,
                };
                self.plan_again(ctx);
            }
            Some(I::KeepProposed(_)) if self.phase == P::Planned => {
                self.keep_proposed = !self.keep_proposed;
            }
            Some(I::Publish(_)) if self.phase == P::Planned => self.publish(ctx),
            Some(I::Discard(_)) if !busy => {
                self.drop_file();
                self.status = None;
            }
            Some(I::Done(_)) if self.phase == P::Published => self.finished = true,
            _ => {}
        }
        let _ = locale;
        Vec::new()
    }
}

/// The plan's own input, as the action's typed request: the origin and the
/// records travel as the JSON they are.
fn import_request(input: &[u8]) -> Option<acts::ImportTransactions> {
    let value: serde_json::Value = serde_json::from_slice(input).ok()?;
    Some(acts::ImportTransactions {
        origin: value.get("origin")?.to_string(),
        records: value.get("records")?.to_string(),
        complete: value.get("complete").and_then(serde_json::Value::as_bool),
        since: value
            .get("since")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

/// The layout a CSV import remembers, as the action's JSON text.
fn layout_json(profile: &wire::MoneyImportProfile) -> String {
    serde_json::json!({
        "header_fingerprint": profile.header_fingerprint,
        "delimiter": profile.delimiter,
        "skip_lines": profile.skip_lines,
        "date_order": profile.date_order,
        "sign_mode": profile.sign_mode,
        "date_col": profile.date_col,
        "amount_col": profile.amount_col,
        "debit_col": profile.debit_col,
        "credit_col": profile.credit_col,
        "desc_col": profile.desc_col,
        "memo_col": profile.memo_col,
        "indicator_col": profile.indicator_col,
        "indicator_out_value": profile.indicator_out_value,
    })
    .to_string()
}

// --- The view -----------------------------------------------------------------

impl Import {
    fn data(&self, locale: Locale) -> wire::MoneyImportData {
        let accounts = self.open_accounts();
        let busy = self.phase == P::Publishing;
        let csv = self
            .file
            .as_ref()
            .is_none_or(|file| source_of(file) == loads::ImportPlanSource::Csv);
        let chosen = accounts
            .iter()
            .find(|line| line.account_id == self.account_id);
        let drawn = self
            .plan
            .as_ref()
            .filter(|_| matches!(self.phase, P::Planned | P::Publishing | P::Published));
        let publishable = if self.phase == P::Planned {
            self.publishable()
        } else {
            0
        };
        let total = drawn.map_or(1, |plan| plan.statements.len());
        wire::MoneyImportData {
            lede: words::import_lede(locale),
            file_label: words::import_file(locale),
            file_value: self
                .file
                .as_ref()
                .map_or_else(|| words::import_no_file(locale), |file| file.name.clone()),
            file_note: match self.phase {
                P::Reading => words::import_reading(locale),
                P::Publishing => words::import_publishing(locale),
                P::Published => words::import_done_note(locale),
                _ => words::import_file_note(locale),
            },
            choose_label: if busy || accounts.is_empty() {
                String::new()
            } else if self.file.is_some() || self.phase == P::Published {
                words::import_choose_another(locale)
            } else {
                words::import_choose(locale)
            },
            account_label: words::import_account(locale),
            account_value: chosen.map_or_else(
                || words::import_no_account_chosen(locale),
                |line| {
                    [
                        Some(line.name.clone()),
                        line.mask.as_ref().map(|m| format!("····{m}")),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ")
                },
            ),
            needs_account: csv,
            account_options: accounts
                .iter()
                .map(|line| {
                    choice(
                        &line.account_id,
                        &line.name,
                        line.account_id == self.account_id,
                        &line
                            .mask
                            .as_ref()
                            .map(|m| format!("····{m}"))
                            .unwrap_or_default(),
                    )
                })
                .collect(),
            account_sheet_title: words::import_account_sheet(locale),
            refusal: drawn
                .and_then(|plan| plan.refusal.clone())
                .unwrap_or_default(),
            statements: drawn
                .map(|plan| {
                    plan.statements
                        .iter()
                        .enumerate()
                        .map(|(index, statement)| self.statement(locale, statement, index, total))
                        .collect()
                })
                .unwrap_or_default(),
            publish_label: if publishable > 0 {
                fill(
                    &words::import_publish(locale),
                    &[(
                        "rows",
                        &fold::count(
                            publishable as usize,
                            &words::row_one(locale),
                            &words::row_many(locale),
                        ),
                    )],
                )
            } else {
                String::new()
            },
            publish_note: if publishable > 0 {
                words::import_publish_note(locale)
            } else {
                String::new()
            },
            discard_label: if self.phase == P::Planned {
                words::import_discard(locale)
            } else {
                String::new()
            },
            done_label: if self.phase == P::Published {
                words::done(locale)
            } else {
                String::new()
            },
            empty: accounts.is_empty().then(|| wire::EmptyState {
                headline: words::import_no_account(locale),
                action_label: words::add_account(locale),
                ..Default::default()
            }),
            add_account_label: words::add_account(locale),
            accounts_route: Some(super::routes::accounts(&words::import_title(locale))),
        }
    }

    #[allow(clippy::too_many_lines)]
    fn statement(
        &self,
        locale: Locale,
        statement: &wire::MoneyStatementPlan,
        index: usize,
        total: usize,
    ) -> wire::MoneyImportStatement {
        use wire::MoneyImportVerdict as V;
        let verdict = |row: &&wire::MoneyImportPlanRow| row.verdict;
        let proposed: Vec<_> = statement
            .rows
            .iter()
            .filter(|row| verdict(row) == V::ProposedDuplicate as i32)
            .collect();
        let rejected: Vec<_> = statement
            .rows
            .iter()
            .filter(|row| verdict(row) == V::Rejected as i32)
            .collect();
        let fresh: Vec<_> = statement
            .rows
            .iter()
            .filter(|row| verdict(row) == V::New as i32)
            .collect();
        let shown = proposed
            .iter()
            .take(SHOWN_ROWS)
            .chain(rejected.iter().take(SHOWN_ROWS))
            .chain(fresh.iter().take(SHOWN_NEW));
        let more: Vec<String> = [
            (proposed.len(), SHOWN_ROWS),
            (rejected.len(), SHOWN_ROWS),
            (fresh.len(), SHOWN_NEW),
        ]
        .into_iter()
        .filter(|(len, cap)| len > cap)
        .map(|(len, cap)| fold::with_n(words::and_more(locale), len - cap))
        .collect();
        let question = statement
            .question
            .as_ref()
            .map(|q| wire::MoneyImportQuestion {
                prompt: words::date_order_prompt(locale),
                samples: q.samples.clone(),
                options: q
                    .options
                    .iter()
                    .filter_map(|option| {
                        match wire::MoneyDateOrder::try_from(*option).unwrap_or_default() {
                            wire::MoneyDateOrder::Mdy => Some(choice(
                                "mdy",
                                &words::date_order_mdy(locale),
                                self.date_order == Some(loads::ImportPlanDateOrder::Mdy),
                                "",
                            )),
                            wire::MoneyDateOrder::Dmy => Some(choice(
                                "dmy",
                                &words::date_order_dmy(locale),
                                self.date_order == Some(loads::ImportPlanDateOrder::Dmy),
                                "",
                            )),
                            _ => None,
                        }
                    })
                    .collect(),
            });
        let sign_guessed = statement
            .warnings
            .contains(&(wire::MoneyImportWarning::SignGuessed as i32));
        let plain = statement.question.is_none() && statement.statement_refusal.is_none();
        let owed = |n: u32, tone: Tone| {
            if n > 0 { tone } else { Tone::Unspecified }
        };
        let mut counts = vec![
            fact(words::count_new(locale), statement.new, Tone::Unspecified),
            fact(
                words::count_already_in(locale),
                statement.already_in,
                Tone::Unspecified,
            ),
            // LINES OWED A LOOK carry the tone that says so while there are any:
            // "Check these" is the seam's, "Can't read" the net's.
            fact(
                words::count_check(locale),
                statement.proposed_duplicates,
                owed(statement.proposed_duplicates, Tone::Seam),
            ),
        ];
        if statement.repeats_in_file > 0 {
            counts.push(fact(
                words::count_repeats(locale),
                statement.repeats_in_file,
                Tone::Unspecified,
            ));
        }
        counts.push(fact(
            words::count_rejected(locale),
            statement.rejected,
            owed(statement.rejected, Tone::Net),
        ));
        wire::MoneyImportStatement {
            key: format!("statement:{index}"),
            title: statement.account_label.clone().unwrap_or_else(|| {
                if total > 1 {
                    fold::with_n(words::statement_n(locale), index + 1)
                } else {
                    words::statement(locale)
                }
            }),
            refusal: statement.statement_refusal.clone().unwrap_or_default(),
            span: fold::span(
                locale,
                statement.first_day.as_deref(),
                statement.last_day.as_deref(),
            ),
            totals: if plain {
                vec![
                    fold::figure(
                        &words::file_in(locale),
                        statement.file_in.as_ref(),
                        Tone::Unspecified,
                    ),
                    fold::figure(
                        &words::file_out(locale),
                        statement.file_out.as_ref(),
                        Tone::Net,
                    ),
                ]
            } else {
                Vec::new()
            },
            counts: if plain { counts } else { Vec::new() },
            rows: shown.map(|row| self.line(locale, row)).collect(),
            more,
            question,
            warnings: statement
                .warnings
                .iter()
                .filter_map(|warning| {
                    match wire::MoneyImportWarning::try_from(*warning).unwrap_or_default() {
                        wire::MoneyImportWarning::ProfileChanged => {
                            Some(words::warn_profile_changed(locale))
                        }
                        wire::MoneyImportWarning::SignGuessed => {
                            Some(words::warn_sign_guessed(locale))
                        }
                        wire::MoneyImportWarning::Unspecified => None,
                    }
                })
                .collect(),
            sign_options: if sign_guessed {
                vec![
                    choice(
                        "debits_negative",
                        &words::sign_negative(locale),
                        self.sign == Some(loads::ImportPlanSign::DebitsNegative),
                        "",
                    ),
                    choice(
                        "debits_positive",
                        &words::sign_positive(locale),
                        self.sign == Some(loads::ImportPlanSign::DebitsPositive),
                        "",
                    ),
                ]
            } else {
                Vec::new()
            },
            sign_label: if sign_guessed {
                words::sign_label(locale)
            } else {
                String::new()
            },
            checkpoint: statement
                .checkpoint
                .as_ref()
                .map(|stated| wire::MoneyFigure {
                    label: words::statement_balance(locale),
                    amount: fold::text(stated.balance.as_ref()),
                    tone: Tone::Unspecified as i32,
                }),
            checkpoint_label: statement
                .checkpoint
                .as_ref()
                .map(|stated| {
                    fill(
                        &words::checkpoint_as_of(locale),
                        &[("day", &fold::day_short(locale, &stated.as_of))],
                    )
                })
                .unwrap_or_default(),
            keep_proposed_label: if statement.proposed_duplicates > 0 {
                words::keep_proposed(locale)
            } else {
                String::new()
            },
            has_proposed: statement.proposed_duplicates > 0,
        }
    }

    fn line(&self, locale: Locale, row: &wire::MoneyImportPlanRow) -> wire::MoneyImportLine {
        use wire::MoneyImportVerdict as V;
        let verdict = V::try_from(row.verdict).unwrap_or_default();
        let (label, tone) = match verdict {
            V::New => (words::chip_new(locale), Tone::Neutral),
            V::AlreadyIn => (words::chip_already_in(locale), Tone::Seam),
            V::ProposedDuplicate => (words::chip_check(locale), Tone::Warning),
            V::RepeatInFile => (words::chip_in_file(locale), Tone::Seam),
            _ => (words::chip_cant_read(locale), Tone::Warning),
        };
        let day = row
            .posted_on
            .as_deref()
            .map(|day| fold::day_short(locale, day))
            .unwrap_or_default();
        let title = row.description.clone().unwrap_or_default();
        let join = |parts: Vec<String>| {
            parts
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" · ")
        };
        let meta = match verdict {
            V::New => join(vec![
                day,
                row.category_label
                    .clone()
                    .unwrap_or_else(|| words::no_category(locale)),
            ]),
            V::ProposedDuplicate => join(vec![day, words::looks_alike(locale)]),
            V::Rejected => String::new(),
            _ => day,
        };
        let reason = row.reason.clone().unwrap_or_default();
        wire::MoneyImportLine {
            key: format!("line:{}", row.line),
            line_label: fold::with_n(words::row_n(locale), row.line),
            accessibility_label: join(vec![
                title.clone(),
                meta.clone(),
                label.clone(),
                reason.clone(),
            ]),
            title,
            meta,
            has_amount: row.amount.is_some(),
            amount: fold::text(row.amount.as_ref()),
            chip: Some(chip(label, tone)),
            reason,
        }
    }
}

fn fact(label: String, n: u32, tone: Tone) -> wire::MoneyFact {
    wire::MoneyFact {
        label,
        detail: n.to_string(),
        action: String::new(),
        tone: tone as i32,
    }
}

impl Screen for Import {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                // The plan is not read again on a change: after a publish its
                // rows are IN, and the page still says what it wrote.
                self.reload_accounts(ctx);
                Vec::new()
            }
            Some(E::MoneyImport(wire::MoneyImportEvent {
                kind: Some(I::Refreshed(_)),
            })) => {
                self.reload_accounts(ctx);
                Vec::new()
            }
            Some(E::MoneyImport(event)) => self.event(event, ctx),
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::BytesPicked(file)) = result.outcome {
                    self.picked(ctx, file);
                }
                Vec::new()
            }
            // LEAVING DROPS THE FILE.
            Some(E::Left(_)) => {
                self.drop_file();
                self.status = None;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_import_state::Content;
        let locale = ctx.locale();
        let content = match &self.accounts {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied => Content::Denied(fold::denied(locale)),
            Phase::Ready(_) => Content::Data(Box::new(self.data(locale))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyImport(
                wire::MoneyImportState {
                    phase: self.phase as i32,
                    content: Some(content),
                    chrome: Some(fold::chrome(
                        locale,
                        words::import_title(locale),
                        &self.parent,
                    )),
                    status: self.status.clone(),
                    account_id: self.account_id.clone(),
                    sheet: self.sheet as i32,
                    keep_proposed: self.keep_proposed,
                    finished: self.finished,
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
