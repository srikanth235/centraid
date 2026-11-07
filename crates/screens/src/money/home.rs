//! MONEY'S HOME (`money.home`): Activity · Spending · Cash flow, and More as a
//! sheet. One screen, the tab a parameter. Activity is home.
//!
//! Roots are places only. Search is the band's key and pushes `money.search`;
//! the header's one trailing action is the Plus glyph, spoken "Import
//! statement"; Activity's header holds the filter menu (account and category, no
//! sort); the month is the title's second line on Activity and Spending, and a
//! tap opens the month sheet: the ONE way to change month. More's rows are
//! routes.
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
        Ok(wire::MoneyDestination::Spending) => Destination::Spending,
        Ok(wire::MoneyDestination::Cashflow) => Destination::Cashflow,
        _ => Destination::Activity,
    };
    Some(Box::new(Home {
        destination,
        month: String::new(),
        account_id: String::new(),
        category_filter: String::new(),
        shown: PAGE,
        sheet: Sheet::None,
        bars: Bars::Week,
        bar: None,
        categories_open: false,
        phase: Phase::Loading,
    }))
}

/// What the tab on screen read.
enum Loaded {
    // Boxed: the three answers are very different sizes.
    Spending(Box<wire::MoneySpending>),
    Activity {
        activity: Box<wire::MoneyActivity>,
        accounts: Box<wire::MoneyAccounts>,
        categories: Box<wire::MoneyCategories>,
        /// The month's overview card reads Spending's answer. A month that will
        /// not read leaves the card out; it never fails the list.
        overview: Option<Box<wire::MoneySpending>>,
    },
    Cashflow(Box<wire::MoneyCashflow>),
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

/// What the Spending chart cuts the month into.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Bars {
    Week,
    Day,
}

impl Bars {
    const fn key(self) -> &'static str {
        match self {
            Self::Week => "week",
            Self::Day => "day",
        }
    }
}

/// The category lines Spending draws before the rest fold into one row.
const CATEGORIES_SHOWN: usize = 3;

struct Home {
    destination: Destination,
    /// `YYYY-MM`; empty until an answer names the month today falls in.
    month: String,
    account_id: String,
    category_filter: String,
    shown: u32,
    sheet: Sheet,
    bars: Bars,
    /// The bar the caption reads; none is the one today falls in.
    bar: Option<usize>,
    /// "N more categories" was tapped: every category is listed.
    categories_open: bool,
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
                let overview = match read::read(
                    ctx,
                    load::money::Spending {
                        month: self.month.clone(),
                    },
                    |a| match a {
                        Answer::MoneySpending(x) => Some(x),
                        _ => None,
                    },
                ) {
                    read::Reading::Data(x) => Some(Box::new(x)),
                    _ => None,
                };
                match (activity, accounts, categories) {
                    (
                        read::Reading::Data(activity),
                        read::Reading::Data(accounts),
                        read::Reading::Data(categories),
                    ) => Phase::Ready(Loaded::Activity {
                        activity: Box::new(activity),
                        accounts: Box::new(accounts),
                        categories: Box::new(categories),
                        overview,
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
            .map(|answer| Loaded::Cashflow(Box::new(answer))),
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
            .map(|answer| Loaded::Spending(Box::new(answer))),
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
        self.bar = None;
        self.categories_open = false;
        self.reload(ctx);
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
            // From Spending's "No category" row the filter lists them in Activity.
            Some(H::CategoryPicked(picked)) => {
                self.category_filter = picked.key;
                self.destination = Destination::Activity;
                self.refilter(ctx);
            }
            Some(H::BarsModePicked(picked)) => {
                let to = if picked.key == Bars::Day.key() {
                    Bars::Day
                } else {
                    Bars::Week
                };
                if to != self.bars {
                    self.bars = to;
                    self.bar = None;
                }
            }
            Some(H::BarPicked(picked)) => self.bar = Some(picked.index as usize),
            Some(H::CategoriesExpanded(_)) => self.categories_open = true,
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
            month_options: fold::month_options(locale, &fold::month_of(today), month),
            ..wire::MoneyHomeData::default()
        };
        match loaded {
            Loaded::Spending(answer) => wire::MoneyHomeData {
                spending: Some(spending(locale, answer, self)),
                ..base
            },
            Loaded::Activity {
                activity, overview, ..
            } => wire::MoneyHomeData {
                activity: Some(self.activity(locale, activity, overview.as_deref())),
                ..base
            },
            Loaded::Cashflow(answer) => wire::MoneyHomeData {
                cashflow: Some(cashflow(locale, answer)),
                ..base
            },
        }
    }

    fn activity(
        &self,
        locale: Locale,
        answer: &wire::MoneyActivity,
        overview: Option<&wire::MoneySpending>,
    ) -> wire::MoneyActivityData {
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
        // THE REVIEW BANNER: the count in its badge, "Need a category · ₹4,310".
        let needs_amounts = answer
            .needs_category
            .iter()
            .filter(|counted| counted.count > 0)
            .map(|counted| fold::text(counted.amount.as_ref()))
            .collect::<Vec<_>>()
            .join(" · ");
        let overview = overview.filter(|o| !o.empty);
        wire::MoneyActivityData {
            heroes: overview.map_or_else(Vec::new, |o| {
                heroes(
                    locale,
                    o,
                    &fill(
                        &words::spent_in(locale),
                        &[("month", &fold::month_name(locale, &o.month))],
                    ),
                )
            }),
            in_out_net: overview.map_or_else(Vec::new, |o| in_out_net(locale, o)),
            days_left_label: overview.map_or_else(String::new, |o| days_left_label(locale, o)),
            needs_title: if needs_count > 0 {
                fill(&words::needs_banner(locale), &[("amount", &needs_amounts)])
            } else {
                String::new()
            },
            needs_count: if needs_count > 0 {
                needs_count.to_string()
            } else {
                String::new()
            },
            review_label: if needs_count > 0 {
                words::review(locale)
            } else {
                String::new()
            },
            needs_label: if needs_count > 0 {
                fold::with_n(
                    if needs_count == 1 {
                        words::note_needs_one(locale)
                    } else {
                        words::note_needs_many(locale)
                    },
                    needs_count,
                )
            } else {
                String::new()
            },
            // THE FILTER THAT LISTS THOSE ROWS is the Needs row's tap.
            needs_key: if needs_count > 0 {
                FILTER_UNCATEGORISED.to_owned()
            } else {
                String::new()
            },
            sections: rows::sections(
                locale,
                &answer.rows,
                &answer.days,
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

    /// THE MONTH IN VIEW, under the app's name: a tap opens the month sheet, the
    /// one way to change month. Activity and Spending, once read; Cash flow
    /// reads twelve months at once, so it has no month to change.
    fn subtitle(&self, locale: Locale) -> Option<wire::HeaderSubtitle> {
        let Phase::Ready(Loaded::Activity { .. } | Loaded::Spending(_)) = &self.phase else {
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
                "activity",
                words::band_activity(locale),
                "List",
                self.destination == Destination::Activity,
            ),
            tab(
                "spending",
                words::band_spending(locale),
                "Coin",
                self.destination == Destination::Spending,
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

/// One hero per currency: spent so far, the plan's bar and what is left of it.
/// `spent_label` is what the amount is called ("Spent in October").
fn heroes(locale: Locale, answer: &wire::MoneySpending, spent_label: &str) -> Vec<wire::MoneyHero> {
    let current_month = answer.month == fold::month_of(&answer.today);
    let tick_bp = if answer.days_in_month > 0 {
        i64::from(answer.day_of_month) * BP / i64::from(answer.days_in_month)
    } else {
        0
    };
    answer
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
                spent_label: spent_label.to_owned(),
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
        .collect()
}

/// In, out and net, one line per currency.
fn in_out_net(locale: Locale, answer: &wire::MoneySpending) -> Vec<wire::MoneyInOutNet> {
    answer
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
                wire::MoneyFigure {
                    // A gain is green and shows its "+"; a loss is the net tone.
                    positive: line.net.as_ref().is_some_and(|n| n.minor > 0),
                    amount: fold::signed(line.net.as_ref()),
                    ..figure(
                        &words::net(locale),
                        line.net.as_ref(),
                        fold::sign_tone(line.net.as_ref()),
                    )
                },
            ],
        })
        .collect()
}

/// "9 days left" while the month in view is the one today falls in.
fn days_left_label(locale: Locale, answer: &wire::MoneySpending) -> String {
    if answer.month == fold::month_of(&answer.today) && answer.days_left > 0 {
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
    }
}

fn spending(locale: Locale, answer: &wire::MoneySpending, view: &Home) -> wire::MoneySpendingData {
    if answer.empty {
        return wire::MoneySpendingData {
            empty: Some(day_one(locale)),
            ..Default::default()
        };
    }
    let current_month = answer.month == fold::month_of(&answer.today);
    let heroes = heroes(
        locale,
        answer,
        &if current_month {
            words::spent_so_far(locale)
        } else {
            fill(
                &words::spent_in(locale),
                &[("month", &fold::month_name(locale, &answer.month))],
            )
        },
    );
    let in_out_net = in_out_net(locale, answer);
    let mut currencies: Vec<&str> = Vec::new();
    for category in &answer.categories {
        if !currencies.contains(&category.currency.as_str()) {
            currencies.push(&category.currency);
        }
    }
    let tables = currencies
        .iter()
        .map(|currency| {
            let lines: Vec<&wire::money_spending::SpendingCategory> = answer
                .categories
                .iter()
                .filter(|line| line.currency == *currency)
                .collect();
            // PAST THE FIRST THREE the rest fold into one row until it is tapped;
            // the core says what they come to.
            let folded = !view.categories_open && lines.len() > CATEGORIES_SHOWN;
            let tail = answer.tail.iter().find(|t| t.currency == *currency);
            let drawn = if folded {
                &lines[..CATEGORIES_SHOWN]
            } else {
                &lines[..]
            };
            wire::MoneyCategoryTable {
                heading: if currencies.len() > 1 {
                    (*currency).to_owned()
                } else {
                    String::new()
                },
                currency: (*currency).to_owned(),
                rows: drawn
                    .iter()
                    .map(|line| category_line(locale, answer, line))
                    .collect(),
                more: tail.filter(|_| folded).map(|tail| {
                    let label = if tail.count == 1 {
                        words::more_categories_one(locale)
                    } else {
                        fold::with_n(words::more_categories_many(locale), tail.count)
                    };
                    let amount = fold::text(tail.spent.as_ref());
                    wire::MoneyRestLine {
                        accessibility_label: fold::spoken(&label, &amount),
                        label,
                        amount,
                        color_key: fold::REST_COLOR_KEY.to_owned(),
                        key: String::new(),
                    }
                }),
                uncategorised: answer
                    .uncategorised
                    .iter()
                    .find(|u| {
                        u.count > 0 && u.amount.as_ref().is_some_and(|a| a.currency == *currency)
                    })
                    .map(|u| {
                        let label = words::no_category(locale);
                        let amount = fold::text(u.amount.as_ref());
                        wire::MoneyRestLine {
                            accessibility_label: fold::spoken(&label, &amount),
                            label,
                            amount,
                            color_key: String::new(),
                            key: FILTER_UNCATEGORISED.to_owned(),
                        }
                    }),
            }
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
    // "N rows need a category" is the "No category" row's job on this page.
    let _ = needs;
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
        days_left_label: days_left_label(locale, answer),
        in_out_net,
        bars: bars(locale, answer, view),
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

/// One category: its dot, spent, progress against the plan and the sentence under.
fn category_line(
    locale: Locale,
    answer: &wire::MoneySpending,
    line: &wire::money_spending::SpendingCategory,
) -> wire::MoneyCategoryLine {
    let planned_minor = line.planned.as_ref().map(|a| a.minor);
    // A BAR'S LENGTH IS DRAWING, NOT A FIGURE.
    let progress_bp = planned_minor
        .filter(|planned| *planned > 0)
        .and_then(|planned| {
            let spent = line.spent.as_ref().map_or(0, |a| a.minor);
            u32::try_from((spent.max(0) * BP / planned).clamp(0, BP)).ok()
        })
        .unwrap_or(0);
    let caption = match (&line.planned, &line.left) {
        (Some(planned), Some(left)) if line.over => fill(
            &words::progress_over(locale),
            &[
                (
                    "over",
                    &fold::text(Some(&wire::MoneyAmount {
                        minor: -left.minor,
                        ..left.clone()
                    })),
                ),
                ("planned", &fold::text(Some(planned))),
            ],
        ),
        (Some(planned), Some(left)) => fill(
            &words::progress_of(locale),
            &[
                ("planned", &fold::text(Some(planned))),
                ("left", &fold::text(Some(left))),
            ],
        ),
        _ => words::progress_no_plan(locale),
    };
    wire::MoneyCategoryLine {
        label: line.label.clone(),
        has_plan: line.planned.is_some(),
        spent: fold::text(line.spent.as_ref()),
        over: line.over,
        color_key: fold::color_key(&line.category_id),
        progress_bp,
        accessibility_label: [
            line.label.clone(),
            fold::text(line.spent.as_ref()),
            caption.clone(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", "),
        caption,
        route: Some(routes::target(
            &answer.month,
            &line.category_id,
            &line.currency,
        )),
    }
}

/// THE SPENDING CHART, one per currency: weeks (or days) of the month as stacked
/// bars. The month's three biggest categories wear their own colour and the rest
/// share the neutral one. Heights are drawing (basis points of the tallest bar
/// or of the plan's pace); the amounts and the pace are the core's.
fn bars(locale: Locale, answer: &wire::MoneySpending, view: &Home) -> Vec<wire::MoneyBars> {
    let series = match view.bars {
        Bars::Week => &answer.weekly,
        Bars::Day => &answer.daily,
    };
    let multiple = series.len() > 1;
    series
        .iter()
        .map(|series| {
            let top: Vec<&wire::money_spending::SpendingCategory> = answer
                .categories
                .iter()
                .filter(|c| {
                    c.currency == series.currency
                        && c.spent.as_ref().is_some_and(|spent| spent.minor > 0)
                })
                .take(CATEGORIES_SHOWN)
                .collect();
            let minor = |amount: &Option<wire::MoneyAmount>| amount.as_ref().map_or(0, |a| a.minor);
            let pace = series.pace.as_ref().map_or(0, |a| a.minor);
            let scale = series
                .buckets
                .iter()
                .map(|b| minor(&b.spent))
                .max()
                .unwrap_or(0)
                .max(pace)
                .max(1);
            let share = |part: i64, whole: i64| {
                u32::try_from((part * BP / whole.max(1)).clamp(0, BP)).unwrap_or(0)
            };
            // The bar the caption reads: the one chosen, else today's, else the
            // last that holds any spending.
            let today_bar = series
                .buckets
                .iter()
                .position(|b| {
                    answer.day_of_month >= b.first_day && answer.day_of_month <= b.last_day
                })
                .filter(|_| answer.day_of_month > 0);
            let last_spent = series.buckets.iter().rposition(|b| minor(&b.spent) > 0);
            let selected = view
                .bar
                .filter(|index| *index < series.buckets.len())
                .or(today_bar)
                .or(last_spent)
                .unwrap_or(0);
            let range = |bucket: &wire::money_spending::SpendBucket| {
                let month = fold::month_short(locale, &answer.month);
                if bucket.first_day == bucket.last_day {
                    fill(
                        &words::bar_range_day(locale),
                        &[("day", &bucket.first_day.to_string()), ("month", &month)],
                    )
                } else {
                    fill(
                        &words::bar_range(locale),
                        &[
                            ("from", &bucket.first_day.to_string()),
                            ("to", &bucket.last_day.to_string()),
                            ("month", &month),
                        ],
                    )
                }
            };
            let bars: Vec<wire::MoneyBar> = series
                .buckets
                .iter()
                .enumerate()
                .map(|(index, bucket)| {
                    let spent = minor(&bucket.spent);
                    let upcoming = answer.day_of_month < bucket.first_day;
                    let mut segments: Vec<wire::MoneyBarSegment> = top
                        .iter()
                        .filter_map(|category| {
                            let part = bucket
                                .parts
                                .iter()
                                .find(|p| p.category_id == category.category_id)
                                .map_or(0, |p| minor(&p.spent));
                            (part > 0).then(|| wire::MoneyBarSegment {
                                color_key: fold::color_key(&category.category_id),
                                share_bp: share(part, spent),
                            })
                        })
                        .collect();
                    let named: u32 = segments.iter().map(|s| s.share_bp).sum();
                    if spent > 0 && named < u32::try_from(BP).unwrap_or(0) {
                        segments.push(wire::MoneyBarSegment {
                            color_key: fold::REST_COLOR_KEY.to_owned(),
                            share_bp: u32::try_from(BP).unwrap_or(0) - named,
                        });
                    }
                    let label = match view.bars {
                        Bars::Week if bucket.first_day == bucket.last_day => {
                            bucket.first_day.to_string()
                        }
                        Bars::Week => format!("{}–{}", bucket.first_day, bucket.last_day),
                        Bars::Day if bucket.first_day % 7 == 1 => bucket.first_day.to_string(),
                        Bars::Day => String::new(),
                    };
                    let words_of = range(bucket);
                    wire::MoneyBar {
                        label,
                        height_bp: share(spent, scale),
                        segments,
                        upcoming,
                        selected: index == selected,
                        accessibility_label: if upcoming {
                            fill(&words::bar_upcoming(locale), &[("range", &words_of)])
                        } else {
                            fill(
                                &words::chart_bar_spoken(locale),
                                &[
                                    ("range", &words_of),
                                    ("amount", &fold::text(bucket.spent.as_ref())),
                                ],
                            )
                        },
                    }
                })
                .collect();
            let caption = series.buckets.get(selected).map_or_else(String::new, |b| {
                let range = range(b);
                let amount = fold::text(b.spent.as_ref());
                if answer.day_of_month < b.first_day {
                    return range;
                }
                // The biggest share: the category that spent most in the bar.
                let biggest = b
                    .parts
                    .iter()
                    .filter(|p| !p.category_id.is_empty())
                    .max_by_key(|p| minor(&p.spent))
                    .and_then(|p| {
                        answer
                            .categories
                            .iter()
                            .find(|c| c.category_id == p.category_id)
                    });
                let caption = fill(
                    &words::bar_caption(locale),
                    &[("range", &range), ("amount", &amount)],
                );
                match biggest {
                    // "15–21 Oct · ₹21,040 · Eating out was the biggest share"
                    Some(category) => format!(
                        "{caption} · {}",
                        fill(&words::bar_biggest(locale), &[("category", &category.label)])
                    ),
                    None => caption,
                }
            });
            wire::MoneyBars {
                currency: series.currency.clone(),
                heading: if multiple {
                    series.currency.clone()
                } else {
                    String::new()
                },
                modes: vec![
                    fold::choice(
                        Bars::Week.key(),
                        &words::bars_week(locale),
                        view.bars == Bars::Week,
                        "",
                    ),
                    fold::choice(
                        Bars::Day.key(),
                        &words::bars_day(locale),
                        view.bars == Bars::Day,
                        "",
                    ),
                ],
                bars,
                pace_bp: if pace > 0 { share(pace, scale) } else { 0 },
                pace_label: if pace > 0 {
                    words::planned_pace(locale)
                } else {
                    String::new()
                },
                caption,
            }
        })
        .collect()
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
