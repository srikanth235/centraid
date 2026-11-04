//! MONEY'S HOME (`money.home`): Spending · Activity · Cash flow, and More as a
//! sheet. One screen, the tab a parameter.
//!
//! Roots are places only. Search is the bar under the title and pushes
//! `money.search`; the header's one trailing action is the Plus glyph, spoken
//! "Import statement"; Activity's header holds the filter menu (account and
//! category, no sort) and the month under the title, which opens the month sheet;
//! More's rows are routes.
//!
//! EACH TAB READS ITS OWN QUERY, and a change of tab, month or filter reads
//! again (a read is local and synchronous, so nothing is held over from the
//! tab before). Activity asks for [`PAGE`] rows at a time: Show more asks for a
//! bigger window, up to the ceiling the core serves ([`MAX_ROWS`]).

use centraid_api_proto::core_v1 as wire;
use wire::money_home_event::Kind as H;
use wire::money_home_state::{Destination, Sheet};
use wire::screen_event::Kind as E;
use wire::status_chip::Tone;

use super::fold::{self, Phase, figure};
use super::{routes, rows};
use crate::catalog::load;
use crate::kit::{menu, read};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

/// Activity rows asked for per page.
pub const PAGE: u32 = 50;

/// The most Activity rows one window holds (the core's page ceiling).
pub const MAX_ROWS: u32 = 500;

const BP: i64 = 10_000;
const BP_PERCENT: i64 = 100;

/// The key a category filter takes for "lines with no category".
pub const FILTER_UNCATEGORISED: &str = "uncategorised";

/// The filter menu's section keys, and the option that is the section off. They
/// read well in a selector (`money-filter-account-all`).
pub const SECTION_ACCOUNT: &str = "account";
pub const SECTION_CATEGORY: &str = "category";
pub const FILTER_ALL: &str = "all";

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyHome(args)) = &route.args else {
        return None;
    };
    let destination = match wire::MoneyDestination::try_from(args.destination) {
        Ok(wire::MoneyDestination::Activity) => Destination::Activity,
        Ok(wire::MoneyDestination::Cashflow) => Destination::Cashflow,
        _ => Destination::Spending,
    };
    Some(Box::new(Home {
        destination,
        month: String::new(),
        account_id: String::new(),
        category_filter: String::new(),
        shown: PAGE,
        sheet: Sheet::None,
        phase: Phase::Loading,
    }))
}

/// What the tab on screen read.
enum Loaded {
    Spending(wire::MoneySpending),
    Activity {
        activity: wire::MoneyActivity,
        accounts: wire::MoneyAccounts,
        categories: wire::MoneyCategories,
    },
    Cashflow(wire::MoneyCashflow),
}

impl Loaded {
    fn today(&self) -> &str {
        match self {
            Self::Spending(a) => &a.today,
            Self::Activity { activity, .. } => &activity.today,
            Self::Cashflow(a) => &a.today,
        }
    }

    /// The month the answer was for.
    fn month(&self) -> &str {
        match self {
            Self::Spending(a) => &a.month,
            Self::Activity { activity, .. } => &activity.month,
            Self::Cashflow(a) => &a.through,
        }
    }
}

struct Home {
    destination: Destination,
    /// `YYYY-MM`; empty until an answer names the month today falls in.
    month: String,
    account_id: String,
    category_filter: String,
    shown: u32,
    sheet: Sheet,
    phase: Phase<Loaded>,
}

impl Home {
    fn reload(&mut self, ctx: &Ctx) {
        self.phase = self.read(ctx);
        // THE MONTH THE ANSWER WAS FOR is the month in view from now on, so a
        // step is arithmetic over a month and never over "this month".
        if let Phase::Ready(loaded) = &self.phase
            && self.month.is_empty()
            && !loaded.month().is_empty()
        {
            self.month = loaded.month().to_owned();
        }
    }

    fn read(&self, ctx: &Ctx) -> Phase<Loaded> {
        use wire::app_query_response::Answer;
        match self.destination {
            Destination::Activity => {
                let activity = read::read(
                    ctx,
                    load::money::Activity {
                        month: self.month.clone(),
                        account_id: (!self.account_id.is_empty()).then(|| self.account_id.clone()),
                        category_filter: Some(
                            match self.category_filter.as_str() {
                                "" => "any",
                                FILTER_UNCATEGORISED => "uncategorised",
                                _ => "is",
                            }
                            .to_owned(),
                        ),
                        category_id: (!self.category_filter.is_empty()
                            && self.category_filter != FILTER_UNCATEGORISED)
                            .then(|| self.category_filter.clone()),
                        limit: self.shown.max(1),
                        ..Default::default()
                    },
                    |a| match a {
                        Answer::MoneyActivity(x) => Some(x),
                        _ => None,
                    },
                );
                let accounts = read::read(ctx, load::money::Accounts {}, |a| match a {
                    Answer::MoneyAccounts(x) => Some(x),
                    _ => None,
                });
                let categories = read::read(ctx, load::money::Categories {}, |a| match a {
                    Answer::MoneyCategories(x) => Some(x),
                    _ => None,
                });
                match (activity, accounts, categories) {
                    (
                        read::Reading::Data(activity),
                        read::Reading::Data(accounts),
                        read::Reading::Data(categories),
                    ) => Phase::Ready(Loaded::Activity {
                        activity,
                        accounts,
                        categories,
                    }),
                    (read::Reading::Denied(_), ..) => Phase::Denied,
                    _ => Phase::Failed,
                }
            }
            Destination::Cashflow => Phase::of(read::read(
                ctx,
                load::money::Cashflow {
                    through: self.month.clone(),
                },
                |a| match a {
                    Answer::MoneyCashflow(x) => Some(x),
                    _ => None,
                },
            ))
            .map(Loaded::Cashflow),
            _ => Phase::of(read::read(
                ctx,
                load::money::Spending {
                    month: self.month.clone(),
                },
                |a| match a {
                    Answer::MoneySpending(x) => Some(x),
                    _ => None,
                },
            ))
            .map(Loaded::Spending),
        }
    }

    fn move_to(&mut self, to: Destination, ctx: &Ctx) {
        if to == self.destination {
            return;
        }
        self.destination = to;
        self.sheet = Sheet::None;
        self.reload(ctx);
    }

    fn set_month(&mut self, month: &str, ctx: &Ctx) {
        // THERE IS NO MONTH AFTER THIS ONE: nothing is dated beyond today's month's reach.
        let today_month = self
            .phase
            .data()
            .map(|loaded| fold::month_of(loaded.today()))
            .unwrap_or_default();
        self.month = if !today_month.is_empty() && month > today_month.as_str() {
            today_month
        } else {
            month.to_owned()
        };
        self.sheet = Sheet::None;
        self.shown = PAGE;
        self.reload(ctx);
    }

    fn step_month(&mut self, months: i32, ctx: &Ctx) {
        if self.month.is_empty() || months == 0 {
            return;
        }
        let next = fold::shift_month(&self.month, i64::from(months));
        self.set_month(&next, ctx);
    }

    /// A filter changed: what Activity held no longer answers it.
    fn refilter(&mut self, ctx: &Ctx) {
        self.sheet = Sheet::None;
        self.shown = PAGE;
        self.reload(ctx);
    }

    fn event(&mut self, event: wire::MoneyHomeEvent, ctx: &Ctx) {
        match event.kind {
            Some(H::Band(band)) => match band.key.as_str() {
                "spending" => self.move_to(Destination::Spending, ctx),
                "activity" => self.move_to(Destination::Activity, ctx),
                "cashflow" => self.move_to(Destination::Cashflow, ctx),
                "more" => self.sheet = Sheet::More,
                _ => {}
            },
            Some(H::MonthStepped(step)) => self.step_month(step.months, ctx),
            Some(H::MonthPicked(picked)) => self.set_month(&picked.month, ctx),
            Some(H::MonthTapped(_)) => self.sheet = Sheet::Month,
            Some(H::FilterMenuPicked(picked)) => {
                let pick = menu::Pick::of(&picked);
                // "All" is the filter off; a key the menu does not hold is nothing.
                let value = if pick.option == FILTER_ALL {
                    ""
                } else {
                    pick.option
                };
                match pick.section {
                    SECTION_ACCOUNT => self.account_id = value.to_owned(),
                    SECTION_CATEGORY => self.category_filter = value.to_owned(),
                    _ => return,
                }
                self.refilter(ctx);
            }
            // CLEAR is the account and the category; the month is not a filter.
            Some(H::FilterMenuCleared(_)) => {
                self.account_id.clear();
                self.category_filter.clear();
                self.refilter(ctx);
            }
            // The Needs row: the filter that lists the rows it counts.
            Some(H::CategoryPicked(picked)) => {
                self.category_filter = picked.key;
                self.refilter(ctx);
            }
            Some(H::SheetClosed(_) | H::MoreOpened(_)) => self.sheet = Sheet::None,
            // A bigger window: the rows on screen stay while the read lands.
            Some(H::ShowMore(_)) => {
                let grown = (self.shown + PAGE).min(MAX_ROWS);
                if grown != self.shown {
                    self.shown = grown;
                    self.reload(ctx);
                }
            }
            Some(H::Refreshed(_)) | None => {}
        }
    }

    // --- The fold ---------------------------------------------------------------

    fn data(&self, locale: Locale, loaded: &Loaded) -> wire::MoneyHomeData {
        let today = loaded.today();
        let month = if self.month.is_empty() {
            loaded.month()
        } else {
            &self.month
        };
        let base = wire::MoneyHomeData {
            today: today.to_owned(),
            month_label: fold::month_label(locale, month),
            can_step_next: !month.is_empty() && month < fold::month_of(today).as_str(),
            // THE STEPPER IS SPENDING'S AND ACTIVITY'S. Cash flow reads twelve
            // months at once, so a month to step through there would move
            // nothing it draws.
            shows_month: self.destination != Destination::Cashflow,
            month_options: fold::month_options(locale, &fold::month_of(today), month),
            ..wire::MoneyHomeData::default()
        };
        match loaded {
            Loaded::Spending(answer) => wire::MoneyHomeData {
                spending: Some(spending(locale, answer)),
                ..base
            },
            Loaded::Activity { activity, .. } => wire::MoneyHomeData {
                activity: Some(self.activity(locale, activity)),
                ..base
            },
            Loaded::Cashflow(answer) => wire::MoneyHomeData {
                cashflow: Some(cashflow(locale, answer)),
                ..base
            },
        }
    }

    fn activity(&self, locale: Locale, answer: &wire::MoneyActivity) -> wire::MoneyActivityData {
        let filtered = !self.account_id.is_empty() || !self.category_filter.is_empty();
        let needs_count: u32 = answer.needs_category.iter().map(|c| c.count).sum();
        let shown = u32::try_from(answer.rows.len()).unwrap_or(u32::MAX);
        let at_ceiling = answer.next.is_some() && shown >= MAX_ROWS;
        let empty = answer.rows.is_empty().then(|| {
            if filtered {
                wire::EmptyState {
                    headline: words::filter_empty(locale),
                    ..Default::default()
                }
            } else {
                wire::EmptyState {
                    headline: words::activity_empty(locale),
                    action_label: words::import_action(locale),
                    ..Default::default()
                }
            }
        });
        wire::MoneyActivityData {
            needs_label: if needs_count > 0 {
                fill(
                    &words::needs_category(locale),
                    &[("n", &needs_count.to_string())],
                )
            } else {
                String::new()
            },
            needs_category: answer
                .needs_category
                .iter()
                .filter(|counted| counted.count > 0)
                .map(|counted| {
                    figure(
                        counted.amount.as_ref().map_or("", |a| a.currency.as_str()),
                        counted.amount.as_ref(),
                        Tone::Neutral,
                    )
                })
                .collect(),
            // THE FILTER THAT LISTS THOSE ROWS is the Needs row's tap.
            needs_key: if needs_count > 0 {
                FILTER_UNCATEGORISED.to_owned()
            } else {
                String::new()
            },
            sections: rows::sections(
                locale,
                &answer.rows,
                &answer.today,
                &words::app_title(locale),
            ),
            window: if at_ceiling {
                fill(&words::window_ceiling(locale), &[("n", &shown.to_string())])
            } else if answer.next.is_some() {
                fill(&words::window_shown(locale), &[("n", &shown.to_string())])
            } else {
                String::new()
            },
            more: answer.next.is_some() && !at_ceiling,
            empty,
        }
    }

    /// THE HEADER'S FILTER BUTTON (R-CHROME-3): Account and Category, each a nested
    /// single choice, no sort. Lit while either narrows Activity. Only on Activity
    /// once it has read, where the chip row stood.
    fn filter_menu(&self, locale: Locale) -> Option<wire::FilterMenu> {
        let Phase::Ready(Loaded::Activity {
            accounts,
            categories,
            ..
        }) = &self.phase
        else {
            return None;
        };
        let (account_options, account_name) = account_options(locale, accounts, &self.account_id);
        let (category_options, category_name) =
            category_options(locale, categories, &self.category_filter);
        Some(menu::menu(
            locale,
            vec![
                menu::nested(
                    menu::single(
                        SECTION_ACCOUNT,
                        words::filter_account(locale),
                        account_options,
                    ),
                    account_name.unwrap_or_else(|| words::all_accounts(locale)),
                ),
                menu::nested(
                    menu::single(
                        SECTION_CATEGORY,
                        words::filter_category(locale),
                        category_options,
                    ),
                    category_name.unwrap_or_else(|| words::all_categories(locale)),
                ),
            ],
            !self.account_id.is_empty() || !self.category_filter.is_empty(),
        ))
    }

    /// THE MONTH IN VIEW, under the app's name: a tap opens the month sheet. Where
    /// the month chip stood (Activity, once read); the band's stepper still steps.
    fn subtitle(&self, locale: Locale) -> Option<wire::HeaderSubtitle> {
        let Phase::Ready(Loaded::Activity { .. }) = &self.phase else {
            return None;
        };
        let label = if self.month.is_empty() {
            words::this_month(locale)
        } else {
            fold::month_label(locale, &self.month)
        };
        Some(wire::HeaderSubtitle {
            spoken: fill(&words::month_spoken(locale), &[("month", &label)]),
            label,
            clearable: false,
            clear_spoken: String::new(),
            tappable: true,
        })
    }

    fn band(&self, locale: Locale) -> Vec<wire::MoneyBandTab> {
        let tab = |key: &str, label: String, icon: &str, current: bool| wire::MoneyBandTab {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            current,
        };
        vec![
            tab(
                "spending",
                words::band_spending(locale),
                "Coin",
                self.destination == Destination::Spending,
            ),
            tab(
                "activity",
                words::band_activity(locale),
                "List",
                self.destination == Destination::Activity,
            ),
            tab(
                "cashflow",
                words::band_cashflow(locale),
                "BarChart2",
                self.destination == Destination::Cashflow,
            ),
            tab("more", words::band_more(locale), "MoreHoriz", false),
        ]
    }

    fn chrome(locale: Locale) -> wire::MoneyHomeChrome {
        let title = words::app_title(locale);
        let more =
            |label: String, meta: String, icon: &str, route: wire::Route| wire::MoneyMoreRow {
                label,
                meta,
                icon_key: icon.to_owned(),
                route: Some(route),
            };
        wire::MoneyHomeChrome {
            title: title.clone(),
            add_label: words::import_action(locale),
            retry: words::retry(locale),
            more_title: words::more_title(locale),
            more_rows: vec![
                more(
                    words::more_accounts(locale),
                    words::more_accounts_meta(locale),
                    "Table",
                    routes::accounts(&title),
                ),
                more(
                    words::more_rules(locale),
                    words::more_rules_meta(locale),
                    "Filter",
                    routes::rules(&title),
                ),
                more(
                    words::more_categories(locale),
                    words::more_categories_meta(locale),
                    "Tag",
                    routes::categories(&title),
                ),
                more(
                    words::more_import(locale),
                    words::more_import_meta(locale),
                    "Download",
                    routes::import(&title),
                ),
            ],
            search_placeholder: words::search_placeholder(locale),
            previous_month_label: words::previous_month(locale),
            next_month_label: words::next_month(locale),
            month_sheet_title: words::month_sheet_title(locale),
            close_label: words::close(locale),
            import_route: Some(routes::import(&title)),
            search_route: Some(routes::search(&title)),
        }
    }
}

fn day_one(locale: Locale) -> wire::EmptyState {
    wire::EmptyState {
        headline: words::day_one(locale),
        action_label: words::import_action(locale),
        ..Default::default()
    }
}

fn spending(locale: Locale, answer: &wire::MoneySpending) -> wire::MoneySpendingData {
    if answer.empty {
        return wire::MoneySpendingData {
            empty: Some(day_one(locale)),
            ..Default::default()
        };
    }
    let current_month = answer.month == fold::month_of(&answer.today);
    let tick_bp = if answer.days_in_month > 0 {
        i64::from(answer.day_of_month) * BP / i64::from(answer.days_in_month)
    } else {
        0
    };
    let heroes = answer
        .per_currency
        .iter()
        .map(|line| {
            let planned = line.planned.as_ref();
            let left = line.left.as_ref();
            let over = left.is_some_and(|l| l.minor < 0);
            let mut figures = Vec::new();
            if planned.is_some() {
                figures.push(figure(&words::planned(locale), planned, Tone::Neutral));
            }
            if left.is_some() {
                figures.push(figure(
                    &words::left(locale),
                    left,
                    if over { Tone::Net } else { Tone::Neutral },
                ));
            }
            if line.refund_credit.as_ref().is_some_and(|r| r.minor != 0) {
                figures.push(figure(
                    &words::refunds(locale),
                    line.refund_credit.as_ref(),
                    Tone::Neutral,
                ));
            }
            let progress = line.progress_bp.unwrap_or(0);
            wire::MoneyHero {
                spent: fold::text(line.spent.as_ref()),
                spent_label: words::spent(locale),
                figures,
                has_bar: planned.is_some(),
                fill_bp: u32::try_from(progress.clamp(0, BP)).unwrap_or(0),
                tick_bp: if current_month {
                    u32::try_from(tick_bp).unwrap_or(0)
                } else {
                    0
                },
                over,
                accessibility_label: if planned.is_none() {
                    words::spent(locale)
                } else {
                    fill(
                        &words::bar_spoken(locale),
                        &[
                            ("percent", &(progress / BP_PERCENT).to_string()),
                            ("day", &answer.day_of_month.to_string()),
                            ("days", &answer.days_in_month.to_string()),
                        ],
                    )
                },
            }
        })
        .collect();
    let in_out_net = answer
        .in_out_net
        .iter()
        .map(|line| wire::MoneyInOutNet {
            figures: vec![
                figure(
                    &words::in_word(locale),
                    line.incoming.as_ref(),
                    Tone::Neutral,
                ),
                figure(
                    &words::out_word(locale),
                    line.outgoing.as_ref(),
                    Tone::Neutral,
                ),
                figure(
                    &words::net(locale),
                    line.net.as_ref(),
                    fold::sign_tone(line.net.as_ref()),
                ),
            ],
        })
        .collect();
    let mut currencies: Vec<&str> = Vec::new();
    for category in &answer.categories {
        if !currencies.contains(&category.currency.as_str()) {
            currencies.push(&category.currency);
        }
    }
    let tables = currencies
        .iter()
        .map(|currency| wire::MoneyCategoryTable {
            heading: if currencies.len() > 1 {
                (*currency).to_owned()
            } else {
                String::new()
            },
            currency: (*currency).to_owned(),
            planned_label: words::planned(locale),
            spent_label: capitalised(&words::spent(locale)),
            left_label: words::left(locale),
            rows: answer
                .categories
                .iter()
                .filter(|line| line.currency == *currency)
                .map(|line| wire::MoneyCategoryLine {
                    label: line.label.clone(),
                    has_plan: line.planned.is_some(),
                    planned: fold::text(line.planned.as_ref()),
                    spent: fold::text(line.spent.as_ref()),
                    left: fold::text(line.left.as_ref()),
                    over: line.over,
                    accessibility_label: [
                        line.label.clone(),
                        if line.over {
                            words::over_plan(locale)
                        } else {
                            String::new()
                        },
                    ]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(", "),
                    route: Some(routes::target(
                        &answer.month,
                        &line.category_id,
                        &line.currency,
                    )),
                })
                .collect(),
        })
        .collect();
    let sum = |counted: &[wire::MoneyCounted]| counted.iter().map(|c| c.count).sum::<u32>();
    let (needs, transfers, future) = (
        sum(&answer.uncategorised),
        sum(&answer.transfers_excluded),
        sum(&answer.future_excluded),
    );
    let note = |n: u32, one: String, many: String| fold::with_n(if n == 1 { one } else { many }, n);
    let mut notes = Vec::new();
    if needs > 0 {
        notes.push(note(
            needs,
            words::note_needs_one(locale),
            words::note_needs_many(locale),
        ));
    }
    if transfers > 0 {
        notes.push(note(
            transfers,
            words::note_transfer_one(locale),
            words::note_transfer_many(locale),
        ));
    }
    if future > 0 {
        notes.push(note(
            future,
            words::note_future_one(locale),
            words::note_future_many(locale),
        ));
    }
    if let Some(last) = &answer.last_import {
        let account = last.account_name.clone().unwrap_or_default();
        let template = if account.is_empty() {
            words::note_imported(locale)
        } else {
            words::note_imported_into(locale)
        };
        let day: String = last.imported_at.chars().take(10).collect();
        notes.push(fill(
            &template,
            &[
                ("day", &fold::day_words(locale, &day, &answer.today)),
                (
                    "source",
                    &if last.source == "ofx" {
                        words::source_ofx(locale)
                    } else {
                        words::source_csv(locale)
                    },
                ),
                ("account", &account),
            ],
        ));
    }
    wire::MoneySpendingData {
        heroes,
        days_left_label: if current_month && answer.days_left > 0 {
            fold::with_n(
                if answer.days_left == 1 {
                    words::days_left_one(locale)
                } else {
                    words::days_left_many(locale)
                },
                answer.days_left,
            )
        } else {
            String::new()
        },
        in_out_net,
        tables,
        notes,
        definitions: fold::definitions(locale, &answer.definitions),
        recurring_label: words::recurring_row(locale),
        recurring_meta: words::recurring_row_meta(locale),
        recurring_route: Some(routes::recurring(&words::app_title(locale))),
        window_note: if answer.truncated {
            words::window_note(locale)
        } else {
            String::new()
        },
        ..Default::default()
    }
}

/// The Account section's options, and the name of the one checked (None for all).
fn account_options(
    locale: Locale,
    accounts: &wire::MoneyAccounts,
    selected: &str,
) -> (Vec<wire::MenuOption>, Option<String>) {
    let mut options = vec![menu::option(
        FILTER_ALL,
        words::all_accounts(locale),
        selected.is_empty(),
    )];
    let mut name = None;
    for line in accounts.on_budget.iter().chain(&accounts.off_budget) {
        // The last four digits tell two accounts of one name apart.
        let label = match &line.mask {
            Some(mask) => format!("{} ····{mask}", line.name),
            None => line.name.clone(),
        };
        if line.account_id == selected {
            name = Some(label.clone());
        }
        options.push(menu::option(
            line.account_id.clone(),
            label,
            line.account_id == selected,
        ));
    }
    (options, name)
}

/// The Category section's options, and the name of the one checked (None for any).
fn category_options(
    locale: Locale,
    categories: &wire::MoneyCategories,
    selected: &str,
) -> (Vec<wire::MenuOption>, Option<String>) {
    let mut options = vec![
        menu::option(
            FILTER_ALL,
            words::all_categories(locale),
            selected.is_empty(),
        ),
        menu::option(
            FILTER_UNCATEGORISED,
            words::needs_category_option(locale),
            selected == FILTER_UNCATEGORISED,
        ),
    ];
    let mut name = (selected == FILTER_UNCATEGORISED).then(|| words::needs_category_option(locale));
    for group in &categories.groups {
        for category in group
            .categories
            .iter()
            .filter(|c| !c.archived || c.category_id == selected)
        {
            if category.category_id == selected {
                name = Some(category.label.clone());
            }
            options.push(menu::option(
                category.category_id.clone(),
                category.label.clone(),
                category.category_id == selected,
            ));
        }
    }
    (options, name)
}

fn cashflow(locale: Locale, answer: &wire::MoneyCashflow) -> wire::MoneyCashflowData {
    let side = |amount: &Option<wire::MoneyAmount>| amount.as_ref().map_or(0, |a| a.minor);
    let used: Vec<&wire::money_cashflow::Series> = answer
        .series
        .iter()
        .filter(|series| {
            series
                .months
                .iter()
                .any(|m| side(&m.incoming) != 0 || side(&m.outgoing) != 0)
        })
        .collect();
    if used.is_empty() {
        return wire::MoneyCashflowData {
            empty: Some(day_one(locale)),
            ..Default::default()
        };
    }
    let series = used
        .iter()
        .map(|series| {
            // A BAR'S LENGTH IS DRAWING, NOT A FIGURE: this series' largest side is full width.
            let largest = series
                .months
                .iter()
                .map(|m| side(&m.incoming).max(side(&m.outgoing)))
                .max()
                .unwrap_or(1)
                .max(1);
            let bp = |minor: i64| u32::try_from(minor * BP / largest).unwrap_or(0);
            wire::MoneyCashflowSeries {
                currency: series.currency.clone(),
                heading: if used.len() > 1 {
                    series.currency.clone()
                } else {
                    String::new()
                },
                in_label: words::in_word(locale),
                out_label: words::out_word(locale),
                partial_label: words::partial_month(locale),
                months: series
                    .months
                    .iter()
                    .map(|month| wire::MoneyCashflowMonth {
                        month: month.month.clone(),
                        label: fold::month_short(locale, &month.month),
                        incoming: fold::text(month.incoming.as_ref()),
                        outgoing: fold::text(month.outgoing.as_ref()),
                        net: fold::text(month.net.as_ref()),
                        net_tone: fold::sign_tone(month.net.as_ref()) as i32,
                        in_bp: bp(side(&month.incoming)),
                        out_bp: bp(side(&month.outgoing)),
                        partial: month.partial,
                        meta: [
                            rate_label_of(locale, month.savings_rate_bp),
                            if month.partial {
                                words::partial_month(locale)
                            } else {
                                String::new()
                            },
                        ]
                        .into_iter()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(" · "),
                        accessibility_label: [
                            fold::month_label(locale, &month.month),
                            if month.partial {
                                words::partial_month(locale)
                            } else {
                                String::new()
                            },
                        ]
                        .into_iter()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(", "),
                    })
                    .collect(),
            }
        })
        .collect();
    wire::MoneyCashflowData {
        series,
        definitions: fold::definitions(locale, &answer.definitions),
        window_note: if answer.truncated {
            words::window_note(locale)
        } else {
            String::new()
        },
        ..Default::default()
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneyHome(wire::MoneyHomeEvent {
                kind: Some(wire::money_home_event::Kind::Refreshed(_)),
            })) => self.reload(ctx),
            Some(E::MoneyHome(home)) => self.event(home, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_home_state::Content;
        let locale = ctx.locale();
        let (content, drawing) = match &self.phase {
            Phase::Loading => (Content::Loading(wire::Loading { first_load: true }), true),
            Phase::Failed => (Content::Failure(read::failure(locale)), true),
            Phase::Denied => (Content::Denied(fold::denied(locale)), false),
            Phase::Ready(loaded) => (Content::Data(Box::new(self.data(locale, loaded))), true),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyHome(wire::MoneyHomeState {
                destination: self.destination as i32,
                content: Some(content),
                sheet: self.sheet as i32,
                band: if drawing {
                    self.band(locale)
                } else {
                    Vec::new()
                },
                chrome: Some(Self::chrome(locale)),
                month: self.month.clone(),
                filter_menu: if drawing {
                    self.filter_menu(locale)
                } else {
                    None
                },
                subtitle: if drawing { self.subtitle(locale) } else { None },
            })),
            ..wire::ViewState::default()
        }
    }
}

fn capitalised(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

fn rate_label_of(locale: Locale, rate: Option<i64>) -> String {
    rate.filter(|rate| *rate >= 0)
        .map(|rate| {
            fill(
                &words::rate_kept(locale),
                &[("percent", &(rate / BP_PERCENT).to_string())],
            )
        })
        .unwrap_or_default()
}
