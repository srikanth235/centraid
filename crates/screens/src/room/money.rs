use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{entity as entity_reads, money as reads};
use centraid_domain::money::{self as fmt_money, Amount};
use centraid_domain::read::Args;
use rand::RngCore as _;
use serde_json::{Map, Value, json};

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::field::Fields;
use super::first;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, fill, home as home_words, money as words, shared};

pub const MONEY: &str = "money";
pub const SPENDING: &str = "money/spending";
pub const CASHFLOW: &str = "money/cashflow";
pub const NEW_TXN: &str = "money/new";
pub const IMPORT_CSV: &str = "money/import-csv";
pub const ACCOUNTS: &str = "money/accounts";
pub const NEW_ACCOUNT: &str = "money/account/new";
pub const BUDGETS: &str = "money/budgets";
pub const RULES: &str = "money/rules";
pub const CATEGORIES: &str = "money/categories";
pub const TRANSFERS: &str = "money/transfers";
pub const DISMISSALS: &str = "money/dismissals";
pub const TRASH: &str = "money/trash";

const EN: Locale = Locale::En;
const LOCALE_TAG: &str = "en-US";
const VIEW_PREF_KEY: &str = "view.money";
const MAX_TEXT: usize = 200;
const MAX_CSV: usize = 32_000;

const FILTER_UNCATEGORIZED: &str = "filter/uncategorized";
const FILTER_PENDING: &str = "filter/pending";

trait FieldsExt {
    fn set_str(&mut self, name: &str, value: &str);
    fn str_or<'a>(&'a self, name: &str, default: &'a str) -> &'a str;
}

impl FieldsExt for Fields {
    fn set_str(&mut self, name: &str, value: &str) {
        self.get_or(name, "");
        if let Some(field) = self.get_mut(name) {
            field.set(value);
        }
    }

    fn str_or<'a>(&'a self, name: &str, default: &'a str) -> &'a str {
        self.value(name).unwrap_or(default)
    }
}

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(MONEY, || Box::new(ActivityRoom::default()))
        .exact(SPENDING, || Box::new(SpendingRoom::default()))
        .exact(CASHFLOW, || Box::new(CashflowRoom::default()))
        .exact(NEW_TXN, || Box::new(TxnForm::new_txn()))
        .exact(IMPORT_CSV, || Box::new(CsvImportRoom::default()))
        .exact(ACCOUNTS, || Box::new(AccountsRoom))
        .exact(NEW_ACCOUNT, || Box::new(NewAccountForm::default()))
        .exact(BUDGETS, || Box::new(BudgetsRoom::default()))
        .exact(RULES, || Box::new(RulesRoom::default()))
        .exact(CATEGORIES, || Box::new(CategoriesRoom::default()))
        .exact(TRANSFERS, || Box::new(TransfersRoom))
        .exact(DISMISSALS, || Box::new(DismissalsRoom))
        .exact(TRASH, || Box::new(MoneyTrash::default()))
        .exact("money/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("money/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("money/txn/") {
                if let Some(id) = rest.strip_suffix("/edit") {
                    return Some(Box::new(TxnForm::edit_txn(id.to_owned())));
                }
                return Some(Box::new(TxnDetailRoom {
                    id: rest.to_owned(),
                }));
            }
            if let Some(rest) = key.strip_prefix("money/account/") {
                if let Some(id) = rest.strip_suffix("/currency") {
                    return Some(Box::new(CurrencyRoom::new(id.to_owned())));
                }
                if let Some(id) = rest.strip_suffix("/checkpoint") {
                    return Some(Box::new(CheckpointForm::new(id.to_owned())));
                }
                if let Some(id) = rest.strip_suffix("/trash-confirm") {
                    return Some(Box::new(TrashAccountConfirm { id: id.to_owned() }));
                }
                return Some(Box::new(AccountDetailRoom {
                    id: rest.to_owned(),
                    loaded: 50,
                }));
            }
            if let Some(rest) = key.strip_prefix("money/category/") {
                if let Some((from, into)) = rest.split_once("/merge/") {
                    return Some(Box::new(CategoryMergeConfirm {
                        from: from.to_owned(),
                        into: into.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/merge") {
                    return Some(Box::new(CategoryMergePick { id: id.to_owned() }));
                }
            }
            None
        }))
}

fn mint_uuid_v7(now_ms: i64) -> String {
    let mut bytes = [0u8; 16];
    let ts = u64::try_from(now_ms.max(0)).unwrap_or(0);
    bytes[0] = ((ts >> 40) & 0xff) as u8;
    bytes[1] = ((ts >> 32) & 0xff) as u8;
    bytes[2] = ((ts >> 24) & 0xff) as u8;
    bytes[3] = ((ts >> 16) & 0xff) as u8;
    bytes[4] = ((ts >> 8) & 0xff) as u8;
    bytes[5] = (ts & 0xff) as u8;
    rand::rng().fill_bytes(&mut bytes[6..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn draft_key(door: &dyn Door) -> Option<String> {
    let vault = door.vault_id();
    if vault.is_empty() {
        None
    } else {
        Some(format!("draft.{vault}.txn"))
    }
}

fn last_used_account(door: &dyn Door) -> Option<String> {
    let text = door.device_get(VIEW_PREF_KEY)?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed
        .get("account")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn save_last_used_account(door: &dyn Door, account_id: &str) {
    if !account_id.is_empty() {
        let _ = door.device_put(
            VIEW_PREF_KEY,
            &json!({ "v": 1, "account": account_id }).to_string(),
        );
    }
}

fn fmt_minor(minor: i64, currency: &str) -> String {
    let exp = u32::from(fmt_money::minor_units(currency));
    fmt_money::format(&Amount::new(minor, currency, exp), LOCALE_TAG)
}

fn fmt_minor_signed(minor: i64, currency: &str) -> String {
    let exp = u32::from(fmt_money::minor_units(currency));
    fmt_money::format_signed(&Amount::new(minor, currency, exp), LOCALE_TAG)
}

fn epoch_ms_to_ymd(ms: i64) -> (i32, u32, u32) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    (year as i32, m as u32, d as u32)
}

fn today_iso(now_ms: i64) -> String {
    let (y, m, d) = epoch_ms_to_ymd(now_ms);
    format!("{y:04}-{m:02}-{d:02}")
}

fn current_ym(now_ms: i64) -> (i32, u32) {
    let (y, m, _) = epoch_ms_to_ymd(now_ms);
    (y, m)
}

fn shift_ym(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let total = year * 12 + (month as i32 - 1) + delta;
    let y = total.div_euclid(12);
    let m = total.rem_euclid(12) as u32 + 1;
    (y, m)
}

fn ym_string(year: i32, month: u32) -> String {
    format!("{year:04}-{month:02}")
}

fn month_bounds(year: i32, month: u32) -> (String, String) {
    let last_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
            if leap { 29 } else { 28 }
        }
        _ => 30,
    };
    (
        format!("{year:04}-{month:02}-01"),
        format!("{year:04}-{month:02}-{last_day:02}"),
    )
}

fn short_month_label(year: i32, month: u32) -> String {
    let name = match month {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        _ => "Dec",
    };
    format!("{name} {year}")
}

fn vault_currency(b: &mut Build<'_>) -> String {
    b.run(&reads::VAULT_CURRENCY, &Args::new())
        .ok()
        .and_then(|ans| ans.rows.into_iter().next())
        .map(|row| row.currency)
        .unwrap_or_else(|| "USD".to_owned())
}

fn account_type_label(code: &str) -> String {
    match code {
        "checking" => words::type_checking(EN),
        "savings" => words::type_savings(EN),
        "credit" => words::type_credit(EN),
        "cash" => words::type_cash(EN),
        "investment" => words::type_investment(EN),
        other => other.to_owned(),
    }
}

fn money_band(sel: &mut Sel, active_tab: &str) -> wire::RoomBand {
    let tabs = vec![
        frame::tab(
            sel,
            "tab/activity",
            &words::tab_activity(EN),
            "Activity",
            active_tab == MONEY,
        ),
        frame::tab(
            sel,
            "tab/spending",
            &words::tab_spending(EN),
            "BarChart2",
            active_tab == SPENDING,
        ),
        frame::tab(
            sel,
            "tab/cashflow",
            &words::tab_cashflow(EN),
            "Coin",
            active_tab == CASHFLOW,
        ),
    ];
    let mut more_trash = blocks::menu_item(
        sel,
        "more/trash",
        &shared::trash_entry(EN),
        Handler::Open(TRASH.to_owned()),
    );
    more_trash.secondary = shared::trash_entry_meta(EN);
    let more_items = vec![
        blocks::menu_item(
            sel,
            "more/accounts",
            &words::more_accounts(EN),
            Handler::Open(ACCOUNTS.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/budgets",
            &words::more_budgets(EN),
            Handler::Open(BUDGETS.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/rules",
            &words::more_rules(EN),
            Handler::Open(RULES.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/categories",
            &words::more_categories(EN),
            Handler::Open(CATEGORIES.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/transfers",
            &words::more_transfers(EN),
            Handler::Open(TRANSFERS.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/dismissals",
            &words::more_dismissals(EN),
            Handler::Open(DISMISSALS.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/import-csv",
            &words::more_import_csv(EN),
            Handler::Open(IMPORT_CSV.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/export",
            &words::more_export(EN),
            Handler::Tag("more:export".to_owned()),
        ),
        more_trash,
    ];
    let more_menu = blocks::menu(
        "band/more/menu",
        vec![blocks::menu_section("", more_items)],
        sel,
    );
    let mut band = frame::band(
        tabs,
        Some(Handler::Tag("nav:home".to_owned())),
        Some(Handler::SearchOpen),
        sel,
    );
    band.more_selector_id = sel.anchor("band/more");
    band.more = Some(more_menu);
    band
}

fn handle_band_nav(tag: &str) -> Option<Outcome> {
    match tag {
        "nav:home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/activity" => Some(Outcome::replace(MONEY)),
        "tab:tab/spending" => Some(Outcome::replace(SPENDING)),
        "tab:tab/cashflow" => Some(Outcome::replace(CASHFLOW)),
        "more:export" => Some(Outcome::say(&words::export_note(EN))),
        _ => None,
    }
}

fn txn_row_menu(sel: &mut Sel, txn: &reads::TxnSummary) -> wire::RoomMenu {
    let id = &txn.id;
    let starred = txn.starred_at.is_some();
    let star_act = if starred {
        Act::new(
            "flag.clear/starred",
            json!({ "flag": "starred", "ids": [id] }),
        )
    } else {
        Act::new(
            "flag.set/starred",
            json!({ "flag": "starred", "ids": [id] }),
        )
    };
    let mut trash = blocks::menu_item(
        sel,
        &format!("row/{id}/menu/trash"),
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
    );
    trash.destructive = true;
    let items = vec![
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/open"),
            &shared::kit_open(EN),
            Handler::Open(format!("money/txn/{id}")),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/edit"),
            &words::menu_edit(EN),
            Handler::Open(format!("money/txn/{id}/edit")),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/star"),
            &if starred {
                words::menu_unstar(EN)
            } else {
                words::menu_star(EN)
            },
            Handler::Act(star_act),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/select"),
            &words::menu_select(EN),
            Handler::SelectMode(true),
        ),
        trash,
    ];
    blocks::menu(
        &format!("row/{id}/menu"),
        vec![blocks::menu_section("", items)],
        sel,
    )
}

#[derive(Default)]
struct ActivityRoom {
    loaded: usize,
    account_filter: Option<String>,
    category_filter: Option<String>,
    bulk_category_id: Option<String>,
}

impl ActivityRoom {
    fn page_size(&self) -> usize {
        self.loaded.max(50)
    }
}

impl RoomScreen for ActivityRoom {
    fn key(&self) -> String {
        MONEY.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let accounts = b
            .run(&reads::ACCOUNTS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let categories = b
            .run(&reads::CATEGORIES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        if self.bulk_category_id.is_none() {
            self.bulk_category_id = categories.first().map(|c| c.id.clone());
        }

        let answer = if let Some(account) = &self.account_filter {
            b.reload(
                &reads::TXN_BY_ACCOUNT,
                &Args::new().text("account", account),
                self.page_size(),
            )
        } else if let Some(category) = &self.category_filter {
            b.reload(
                &reads::TXN_BY_CATEGORY,
                &Args::new().text("category", category),
                self.page_size(),
            )
        } else {
            b.reload(&reads::TXN_ACTIVITY, &Args::new(), self.page_size())
        };

        let answer = match answer {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, MONEY)
                    .title(&words::title(EN))
                    .band(money_band(&mut b.sel, MONEY))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let uncategorized_only = b.ui.is_filtered(FILTER_UNCATEGORIZED);
        let pending_only = b.ui.is_filtered(FILTER_PENDING);
        let term = b.ui.search_term().trim().to_ascii_lowercase();

        let mut filtered = Vec::new();
        for txn in &answer.rows {
            if pending_only && txn.status != "pending" {
                continue;
            }
            if uncategorized_only {
                let splits = b
                    .run(&reads::TXN_SPLITS, &Args::new().text("txn", &txn.id))
                    .map(|a| a.rows)
                    .unwrap_or_default();
                if !splits.is_empty() {
                    continue;
                }
            }
            if !term.is_empty() {
                let matches = txn.title.to_ascii_lowercase().contains(&term)
                    || txn.account_title.to_ascii_lowercase().contains(&term)
                    || txn
                        .memo
                        .as_deref()
                        .is_some_and(|m| m.to_ascii_lowercase().contains(&term));
                if !matches {
                    continue;
                }
            }
            filtered.push(txn.clone());
        }

        let selecting = b.ui.selecting();
        let all_ids: Vec<String> = filtered.iter().map(|t| t.id.clone()).collect();
        b.ui.list(all_ids);

        let mut account_items = vec![{
            let mut item = blocks::menu_item(
                &mut b.sel,
                "filter/account/all",
                &words::filter_all_accounts(EN),
                Handler::Tag("filter:account:all".to_owned()),
            );
            item.checked = self.account_filter.is_none();
            item
        }];
        for acc in &accounts {
            let mut item = blocks::menu_item(
                &mut b.sel,
                &format!("filter/account/{}", acc.id),
                &acc.title,
                Handler::Tag(format!("filter:account:{}", acc.id)),
            );
            item.checked = self.account_filter.as_deref() == Some(acc.id.as_str());
            account_items.push(item);
        }

        let mut category_items = vec![{
            let mut item = blocks::menu_item(
                &mut b.sel,
                "filter/category/all",
                &words::filter_all_categories(EN),
                Handler::Tag("filter:category:all".to_owned()),
            );
            item.checked = self.category_filter.is_none();
            item
        }];
        for cat in &categories {
            let mut item = blocks::menu_item(
                &mut b.sel,
                &format!("filter/category/{}", cat.id),
                &cat.title,
                Handler::Tag(format!("filter:category:{}", cat.id)),
            );
            item.checked = self.category_filter.as_deref() == Some(cat.id.as_str());
            category_items.push(item);
        }

        let mut uncat_item = blocks::menu_item(
            &mut b.sel,
            FILTER_UNCATEGORIZED,
            &words::filter_uncategorized(EN),
            Handler::Filter(FILTER_UNCATEGORIZED.to_owned()),
        );
        uncat_item.checked = uncategorized_only;
        let mut pending_item = blocks::menu_item(
            &mut b.sel,
            FILTER_PENDING,
            &words::filter_pending(EN),
            Handler::Filter(FILTER_PENDING.to_owned()),
        );
        pending_item.checked = pending_only;

        let filter_menu = blocks::menu(
            "money/filter",
            vec![
                blocks::menu_section(
                    &words::filter_section_show(EN),
                    vec![uncat_item, pending_item],
                ),
                blocks::menu_section(&words::filter_section_account(EN), account_items),
                blocks::menu_section(&words::filter_section_category(EN), category_items),
            ],
            &mut b.sel,
        );

        let scope_label = if let Some(acc_id) = &self.account_filter {
            accounts
                .iter()
                .find(|a| &a.id == acc_id)
                .map(|a| a.title.clone())
        } else if let Some(cat_id) = &self.category_filter {
            categories
                .iter()
                .find(|c| &c.id == cat_id)
                .map(|c| c.title.clone())
        } else {
            None
        };

        let mut frame = room(wire::RoomKind::AppPlace, MONEY)
            .title(&words::title(EN))
            .filter(&mut b.sel, filter_menu, b.ui)
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_txn(EN),
                Handler::Open(NEW_TXN.to_owned()),
            )
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN));

        if let Some(label) = scope_label {
            frame = frame.scope(&mut b.sel, &label, Handler::Tag("scope:clear".to_owned()));
        } else if !filtered.is_empty() {
            frame = frame.subtitle(&words::txn_count(EN, filtered.len() as u64));
        }

        if selecting {
            let picked: Vec<String> = b.ui.picked().map(str::to_owned).collect();
            let mut actions = Vec::new();
            if let Some(cat_id) = &self.bulk_category_id {
                actions.push(blocks::menu_item(
                    &mut b.sel,
                    "selection/categorize",
                    &words::menu_categorize(EN),
                    Handler::Tag(format!("bulk:categorize:{cat_id}")),
                ));
            }
            actions.push(blocks::menu_item(
                &mut b.sel,
                "selection/tag",
                &words::menu_tag(EN),
                Handler::Tag("bulk:tag".to_owned()),
            ));
            let mut trash_item = blocks::menu_item(
                &mut b.sel,
                "selection/trash",
                &shared::trash_move(EN),
                Handler::Tag("bulk:trash".to_owned()),
            );
            trash_item.destructive = true;
            trash_item.enabled = !picked.is_empty();
            actions.push(trash_item);
            let label = words::selected_count(EN, b.ui.picked_count() as u64);
            frame = frame.selection(&mut b.sel, b.ui, &label, actions);
        } else {
            frame = frame.band(money_band(&mut b.sel, MONEY));
        }

        let blocks_out = if filtered.is_empty() {
            if !term.is_empty() {
                vec![blocks::empty(
                    glyph("Coin", "app.money"),
                    &words::empty_search_title(EN),
                    &fill(
                        &words::empty_search_body(EN),
                        &[("term", b.ui.search_term())],
                    ),
                    None,
                )]
            } else {
                vec![first::first_open(
                    b,
                    first::FirstOpen {
                        app: "money",
                        icon: "Coin",
                        hue: "app.money",
                        sentence: home_words::first_open_money(EN),
                        action: Some((
                            Handler::Open(IMPORT_CSV.to_owned()),
                            words::empty_action(EN),
                        )),
                        tail: first::Tail::None,
                        refused: None,
                    },
                )]
            }
        } else {
            let rows: Vec<wire::RoomBlock> = filtered
                .iter()
                .map(|txn| {
                    let tap = if selecting {
                        Handler::Pick(txn.id.clone())
                    } else {
                        Handler::Open(format!("money/txn/{}", txn.id))
                    };
                    let meta = format!("{} · {}", txn.posted_on, txn.account_title);
                    let amount = fmt_minor(txn.amount_minor, &txn.currency);
                    let tone = if txn.amount_minor > 0 {
                        wire::RoomTone::Net
                    } else {
                        wire::RoomTone::Neutral
                    };
                    let menu = txn_row_menu(&mut b.sel, txn);
                    let mut row =
                        blocks::row(&mut b.sel, &format!("row/{}", txn.id), &txn.title, tap)
                            .meta(&meta)
                            .trailing(&amount, tone)
                            .selected(b.ui.is_picked(&txn.id))
                            .menu(menu)
                            .swipe(
                                &mut b.sel,
                                &format!("row/{}/trash", txn.id),
                                &shared::trash_move(EN),
                                Handler::Act(Act::new("entity.trash", json!({ "ids": [txn.id] }))),
                            );
                    if txn.status == "pending" {
                        row = row.pending().chip(blocks::chip(
                            &words::pending_chip(EN),
                            wire::RoomTone::Warning,
                        ));
                    }
                    row.into_block()
                })
                .collect();
            let mut section =
                blocks::section(&mut b.sel, "section/activity", &words::tab_activity(EN))
                    .blocks(rows);
            if answer.next.is_some() {
                section = section.next_page(&mut b.sel, "section/activity/next");
            }
            vec![section.into_block()]
        };

        frame.ready(blocks_out).build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(tag) {
            return outcome;
        }
        if tag == "scope:clear" {
            self.account_filter = None;
            self.category_filter = None;
            return Outcome::default();
        }
        if tag == "filter:account:all" {
            self.account_filter = None;
            return Outcome::default();
        }
        if let Some(id) = tag.strip_prefix("filter:account:") {
            self.account_filter = Some(id.to_owned());
            self.category_filter = None;
            return Outcome::default();
        }
        if tag == "filter:category:all" {
            self.category_filter = None;
            return Outcome::default();
        }
        if let Some(id) = tag.strip_prefix("filter:category:") {
            self.category_filter = Some(id.to_owned());
            self.account_filter = None;
            return Outcome::default();
        }
        if let Some(cat_id) = tag.strip_prefix("bulk:categorize:") {
            let ids: Vec<String> = e.ui.picked().map(str::to_owned).collect();
            if ids.is_empty() {
                return Outcome::default();
            }
            return match e.door.act(&Act::new(
                "txn.categorize",
                json!({ "ids": ids, "category_id": cat_id }),
            )) {
                Ok(done) => {
                    e.ui.select_mode(false);
                    Outcome::done(&words::categorized(EN), done.undo)
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "bulk:tag" {
            let ids: Vec<String> = e.ui.picked().map(str::to_owned).collect();
            if ids.is_empty() {
                return Outcome::default();
            }
            return match e.door.act(&Act::new(
                "tag.add",
                json!({ "ids": ids, "tag": "reviewed" }),
            )) {
                Ok(done) => {
                    e.ui.select_mode(false);
                    Outcome::done(&words::tagged(EN), done.undo)
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "bulk:trash" {
            let ids: Vec<String> = e.ui.picked().map(str::to_owned).collect();
            if ids.is_empty() {
                return Outcome::default();
            }
            return match e.door.act(&Act::new("entity.trash", json!({ "ids": ids }))) {
                Ok(done) => {
                    e.ui.select_mode(false);
                    Outcome::done(&done.sentence, done.undo)
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "next_page" {
            self.loaded = self.page_size().saturating_add(50);
        }
        Outcome::default()
    }
}

#[derive(Default)]
struct SpendingRoom {
    year_month: Option<(i32, u32)>,
    readout_point_id: String,
}

impl SpendingRoom {
    fn ym(&mut self, now_ms: i64) -> (i32, u32) {
        *self.year_month.get_or_insert_with(|| current_ym(now_ms))
    }
}

impl RoomScreen for SpendingRoom {
    fn key(&self) -> String {
        SPENDING.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let (year, month) = self.ym(b.door.now_ms());
        let (from_day, to_day) = month_bounds(year, month);
        let month_key = ym_string(year, month);
        let month_label = short_month_label(year, month);
        let currency = vault_currency(b);

        let categories = match b.run(&reads::CATEGORIES, &Args::new()) {
            Ok(ans) => ans.rows,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, SPENDING)
                    .title(&words::spending_title(EN))
                    .band(money_band(&mut b.sel, SPENDING))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let budgets = b
            .run(
                &reads::BUDGETS_FOR_MONTH,
                &Args::new().text("month", &month_key),
            )
            .map(|a| a.rows)
            .unwrap_or_default();

        let mut total_spent: i64 = 0;
        let mut total_budget: i64 = 0;
        let mut points = Vec::new();
        let mut breakdown_rows = Vec::new();
        let mut max_spent: i64 = 0;

        for (idx, cat) in categories.iter().enumerate() {
            let spending = b
                .run(
                    &reads::SPENDING_BY_CATEGORY,
                    &Args::new()
                        .text("category", &cat.id)
                        .text("from_day", &from_day)
                        .text("to_day", &to_day),
                )
                .ok()
                .and_then(|a| a.rows.into_iter().next());
            let raw = spending.as_ref().map_or(0, |s| s.total_minor);
            let spent = (-raw).max(0);
            let budget_minor = budgets
                .iter()
                .find(|bg| bg.category_id == cat.id)
                .map(|bg| bg.amount_minor);
            if let Some(bg) = budget_minor {
                total_budget += bg;
            }
            if spent == 0 && budget_minor.is_none() {
                continue;
            }
            total_spent += spent;
            max_spent = max_spent.max(spent);
            let formatted = fmt_minor(spent, &currency);
            let point_id = format!("cat:{}", cat.id);
            points.push(wire::RoomChartPoint {
                id: point_id,
                x: idx as f64,
                y: spent as f64,
                y_low: 0.0,
                y_high: 0.0,
                x_label: cat.title.clone(),
                y_label: formatted.clone(),
                a11y_label: format!("{}: {formatted}", cat.title),
            });
            let meta = budget_minor
                .map(|bg| {
                    fill(
                        &words::spending_budget_caption(EN),
                        &[("amount", &fmt_minor(bg, &currency))],
                    )
                })
                .unwrap_or_default();
            let tone = match budget_minor {
                Some(bg) if spent > bg => wire::RoomTone::Warning,
                _ => wire::RoomTone::Neutral,
            };
            breakdown_rows.push(
                blocks::still_row(&mut b.sel, &format!("spending/{}", cat.id), &cat.title)
                    .meta(&meta)
                    .trailing(&formatted, tone)
                    .into_block(),
            );
        }

        let mut blocks_out = Vec::new();
        let caption = if total_budget > 0 {
            fill(
                &words::spending_budget_caption(EN),
                &[("amount", &fmt_minor(total_budget, &currency))],
            )
        } else {
            month_label.clone()
        };
        let fig_tone = if total_budget > 0 && total_spent > total_budget {
            wire::RoomTone::Warning
        } else {
            wire::RoomTone::Neutral
        };
        blocks_out.push(blocks::figure(
            &words::spending_total_label(EN),
            &fmt_minor(total_spent, &currency),
            &caption,
            fig_tone,
        ));

        let chart_sel = blocks::canvas(&mut b.sel, "chart/spending", "chart:spending");
        let y_ticks = if max_spent > 0 {
            vec![
                wire::RoomChartTick {
                    at: 0.0,
                    label: fmt_minor(0, &currency),
                },
                wire::RoomChartTick {
                    at: max_spent as f64,
                    label: fmt_minor(max_spent, &currency),
                },
            ]
        } else {
            Vec::new()
        };
        let mut rules = Vec::new();
        if total_budget > 0 {
            rules.push(wire::RoomChartRule {
                at: total_budget as f64,
                label: fill(
                    &words::spending_budget_caption(EN),
                    &[("amount", &fmt_minor(total_budget, &currency))],
                ),
                tone: wire::RoomTone::Warning as i32,
            });
        }
        let series = if points.is_empty() {
            Vec::new()
        } else {
            vec![wire::RoomChartSeries {
                id: "spending".to_owned(),
                label: words::spending_title(EN),
                hue_key: "app.money".to_owned(),
                mark: wire::RoomChartMark::Bar as i32,
                stack: String::new(),
                points: points.clone(),
            }]
        };
        blocks_out.push(blocks::chart(wire::RoomChart {
            selector_id: chart_sel,
            summary: fill(
                &words::spending_chart_summary(EN),
                &[("month", &month_label)],
            ),
            series,
            x_ticks: points
                .iter()
                .map(|p| wire::RoomChartTick {
                    at: p.x,
                    label: p.x_label.clone(),
                })
                .collect(),
            y_ticks,
            rules,
            readout_point_id: self.readout_point_id.clone(),
            empty_sentence: fill(&words::spending_empty(EN), &[("month", &month_label)]),
        }));

        if let Some(scrubbed) = points.iter().find(|p| p.id == self.readout_point_id) {
            blocks_out.push(blocks::figure(
                &words::spending_readout_label(EN),
                &scrubbed.y_label,
                &scrubbed.x_label,
                wire::RoomTone::Neutral,
            ));
        }

        if !breakdown_rows.is_empty() {
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/categories",
                    &words::spending_by_category(EN),
                )
                .blocks(breakdown_rows)
                .into_block(),
            );
        }

        room(wire::RoomKind::AppPlace, SPENDING)
            .title(&words::spending_title(EN))
            .subtitle(&month_label)
            .key(
                &mut b.sel,
                "key/prev",
                wire::RoomKeyRole::Tool,
                "ChevronLeft",
                &words::prev_month(EN),
                Handler::Tag("month:prev".to_owned()),
            )
            .key(
                &mut b.sel,
                "key/next",
                wire::RoomKeyRole::Tool,
                "ChevronRight",
                &words::next_month(EN),
                Handler::Tag("month:next".to_owned()),
            )
            .band(money_band(&mut b.sel, SPENDING))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(tag) {
            return outcome;
        }
        match tag {
            "month:prev" => {
                let (y, m) = self.ym(e.door.now_ms());
                self.year_month = Some(shift_ym(y, m, -1));
                self.readout_point_id.clear();
            }
            "month:next" => {
                let (y, m) = self.ym(e.door.now_ms());
                self.year_month = Some(shift_ym(y, m, 1));
                self.readout_point_id.clear();
            }
            "chart:spending" => {
                if let Input::Canvas(wire::room_canvas_event::Kind::ChartScrub(scrub)) = input {
                    self.readout_point_id = scrub.point_id.clone();
                }
            }
            _ => {}
        }
        Outcome::default()
    }
}

#[derive(Default)]
struct CashflowRoom {
    year_month: Option<(i32, u32)>,
    readout_point_id: String,
}

impl CashflowRoom {
    fn ym(&mut self, now_ms: i64) -> (i32, u32) {
        *self.year_month.get_or_insert_with(|| current_ym(now_ms))
    }
}

impl RoomScreen for CashflowRoom {
    fn key(&self) -> String {
        CASHFLOW.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let (end_y, end_m) = self.ym(b.door.now_ms());
        let currency = vault_currency(b);

        let mut inflow_points = Vec::new();
        let mut outflow_points = Vec::new();
        let mut net_points = Vec::new();
        let mut x_ticks = Vec::new();
        let mut month_rows = Vec::new();
        let mut total_inflow: i64 = 0;
        let mut total_outflow: i64 = 0;
        let mut max_val: i64 = 0;

        for offset in -5..=0 {
            let (y, m) = shift_ym(end_y, end_m, offset);
            let (from_day, to_day) = month_bounds(y, m);
            let label = short_month_label(y, m);
            let key = ym_string(y, m);
            let cf = match b.run(
                &reads::CASHFLOW_WINDOW,
                &Args::new()
                    .text("from_day", &from_day)
                    .text("to_day", &to_day),
            ) {
                Ok(ans) => ans.rows.into_iter().next().unwrap_or(reads::CashflowTotal {
                    inflow_minor: 0,
                    outflow_minor: 0,
                    line_count: 0,
                }),
                Err(refused) => {
                    return room(wire::RoomKind::AppPlace, CASHFLOW)
                        .title(&words::cashflow_title(EN))
                        .band(money_band(&mut b.sel, CASHFLOW))
                        .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                        .build();
                }
            };
            let idx = (offset + 5) as f64;
            let net = cf.inflow_minor - cf.outflow_minor;
            total_inflow += cf.inflow_minor;
            total_outflow += cf.outflow_minor;
            max_val = max_val.max(cf.inflow_minor).max(cf.outflow_minor);

            let in_str = fmt_minor(cf.inflow_minor, &currency);
            let out_str = fmt_minor(cf.outflow_minor, &currency);
            let net_str = fmt_minor_signed(net, &currency);

            x_ticks.push(wire::RoomChartTick {
                at: idx,
                label: label.clone(),
            });
            inflow_points.push(wire::RoomChartPoint {
                id: format!("in:{key}"),
                x: idx,
                y: cf.inflow_minor as f64,
                y_low: 0.0,
                y_high: 0.0,
                x_label: label.clone(),
                y_label: in_str.clone(),
                a11y_label: format!("{label} {}: {in_str}", words::cashflow_inflow(EN)),
            });
            outflow_points.push(wire::RoomChartPoint {
                id: format!("out:{key}"),
                x: idx,
                y: cf.outflow_minor as f64,
                y_low: 0.0,
                y_high: 0.0,
                x_label: label.clone(),
                y_label: out_str.clone(),
                a11y_label: format!("{label} {}: {out_str}", words::cashflow_outflow(EN)),
            });
            net_points.push(wire::RoomChartPoint {
                id: format!("net:{key}"),
                x: idx,
                y: net as f64,
                y_low: 0.0,
                y_high: 0.0,
                x_label: label.clone(),
                y_label: net_str.clone(),
                a11y_label: format!("{label} {}: {net_str}", words::cashflow_net(EN)),
            });
            let row_tone = if net >= 0 {
                wire::RoomTone::Net
            } else {
                wire::RoomTone::Warning
            };
            month_rows.push(
                blocks::still_row(&mut b.sel, &format!("cf/{key}"), &label)
                    .meta(&format!("{in_str} · -{out_str}"))
                    .trailing(&net_str, row_tone)
                    .into_block(),
            );
        }

        let total_net = total_inflow - total_outflow;
        let net_tone = if total_net >= 0 {
            wire::RoomTone::Net
        } else {
            wire::RoomTone::Warning
        };
        let mut blocks_out = vec![blocks::figure(
            &words::cashflow_net(EN),
            &fmt_minor_signed(total_net, &currency),
            &format!(
                "{} {} · {} {}",
                words::cashflow_inflow(EN),
                fmt_minor(total_inflow, &currency),
                words::cashflow_outflow(EN),
                fmt_minor(total_outflow, &currency)
            ),
            net_tone,
        )];

        let chart_sel = blocks::canvas(&mut b.sel, "chart/cashflow", "chart:cashflow");
        let series = if total_inflow == 0 && total_outflow == 0 {
            Vec::new()
        } else {
            vec![
                wire::RoomChartSeries {
                    id: "inflow".to_owned(),
                    label: words::cashflow_inflow(EN),
                    hue_key: "state.positive".to_owned(),
                    mark: wire::RoomChartMark::Bar as i32,
                    stack: String::new(),
                    points: inflow_points,
                },
                wire::RoomChartSeries {
                    id: "outflow".to_owned(),
                    label: words::cashflow_outflow(EN),
                    hue_key: "app.money".to_owned(),
                    mark: wire::RoomChartMark::Bar as i32,
                    stack: String::new(),
                    points: outflow_points,
                },
                wire::RoomChartSeries {
                    id: "net".to_owned(),
                    label: words::cashflow_net(EN),
                    hue_key: "text.ink".to_owned(),
                    mark: wire::RoomChartMark::Line as i32,
                    stack: String::new(),
                    points: net_points.clone(),
                },
            ]
        };

        blocks_out.push(blocks::chart(wire::RoomChart {
            selector_id: chart_sel,
            summary: words::cashflow_chart_summary(EN),
            series,
            x_ticks,
            y_ticks: if max_val > 0 {
                vec![
                    wire::RoomChartTick {
                        at: 0.0,
                        label: fmt_minor(0, &currency),
                    },
                    wire::RoomChartTick {
                        at: max_val as f64,
                        label: fmt_minor(max_val, &currency),
                    },
                ]
            } else {
                Vec::new()
            },
            rules: vec![wire::RoomChartRule {
                at: 0.0,
                label: fmt_minor(0, &currency),
                tone: wire::RoomTone::Neutral as i32,
            }],
            readout_point_id: self.readout_point_id.clone(),
            empty_sentence: words::cashflow_empty(EN),
        }));

        if let Some(scrubbed) = net_points.iter().find(|p| p.id == self.readout_point_id) {
            blocks_out.push(blocks::figure(
                &words::cashflow_readout_label(EN),
                &scrubbed.y_label,
                &scrubbed.x_label,
                wire::RoomTone::Neutral,
            ));
        }

        blocks_out.push(
            blocks::section(&mut b.sel, "section/months", &words::cashflow_months(EN))
                .blocks(month_rows)
                .into_block(),
        );

        room(wire::RoomKind::AppPlace, CASHFLOW)
            .title(&words::cashflow_title(EN))
            .subtitle(&short_month_label(end_y, end_m))
            .key(
                &mut b.sel,
                "key/prev",
                wire::RoomKeyRole::Tool,
                "ChevronLeft",
                &words::prev_month(EN),
                Handler::Tag("month:prev".to_owned()),
            )
            .key(
                &mut b.sel,
                "key/next",
                wire::RoomKeyRole::Tool,
                "ChevronRight",
                &words::next_month(EN),
                Handler::Tag("month:next".to_owned()),
            )
            .band(money_band(&mut b.sel, CASHFLOW))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(tag) {
            return outcome;
        }
        match tag {
            "month:prev" => {
                let (y, m) = self.ym(e.door.now_ms());
                self.year_month = Some(shift_ym(y, m, -1));
                self.readout_point_id.clear();
            }
            "month:next" => {
                let (y, m) = self.ym(e.door.now_ms());
                self.year_month = Some(shift_ym(y, m, 1));
                self.readout_point_id.clear();
            }
            "chart:cashflow" => {
                if let Input::Canvas(wire::room_canvas_event::Kind::ChartScrub(scrub)) = input {
                    self.readout_point_id = scrub.point_id.clone();
                }
            }
            _ => {}
        }
        Outcome::default()
    }
}

struct TxnDetailRoom {
    id: String,
}

impl RoomScreen for TxnDetailRoom {
    fn key(&self) -> String {
        format!("money/txn/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let txn = match b.run(&reads::TXN_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => ans.rows.into_iter().next(),
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::txn_detail_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(txn) = txn else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::txn_detail_title(EN))
                .back(&mut b.sel, &words::title(EN))
                .ready(vec![blocks::empty(
                    glyph("Coin", "app.money"),
                    &words::txn_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let splits = b
            .run(&reads::TXN_SPLITS, &Args::new().text("txn", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let sources = b
            .run(&reads::TXN_SOURCES, &Args::new().text("txn", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let transfers = b
            .run(&reads::TXN_TRANSFER, &Args::new().text("txn", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let linked_ids = b
            .run(&reads::LINKED, &Args::new().text("id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let mentioned = b
            .run(&reads::MENTIONED_IN, &Args::new().text("id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let attached = b
            .run(&reads::ATTACHMENTS, &Args::new().text("id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let homed_photos = b
            .run(
                &entity_reads::IN_HOME,
                &Args::new().text("home", &self.id).text("kind", "photo"),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let homed_docs = b
            .run(
                &entity_reads::IN_HOME,
                &Args::new().text("home", &self.id).text("kind", "document"),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let rev_count = b
            .run(&reads::REVISIONS_COUNT, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or(0, |c| c.0);

        let amount_str = fmt_minor(txn.amount_minor, &txn.currency);
        let starred = txn.starred_at.is_some();
        let star_act = if starred {
            Act::new(
                "flag.clear/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        } else {
            Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        };
        let mut trash_item = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            Handler::Act(Act::new("entity.trash", json!({ "ids": [self.id] }))),
        );
        trash_item.destructive = true;
        let mut menu_items = vec![
            blocks::menu_item(
                &mut b.sel,
                "menu/edit",
                &words::menu_edit(EN),
                Handler::Open(format!("money/txn/{}/edit", self.id)),
            ),
            blocks::menu_item(
                &mut b.sel,
                "menu/star",
                &if starred {
                    words::menu_unstar(EN)
                } else {
                    words::menu_star(EN)
                },
                Handler::Act(star_act),
            ),
            blocks::menu_item(
                &mut b.sel,
                "menu/share",
                &words::menu_share(EN),
                Handler::Tag("share".to_owned()),
            ),
        ];
        if !transfers.is_empty() {
            menu_items.push(blocks::menu_item(
                &mut b.sel,
                "menu/unlink_transfer",
                &words::menu_unlink_transfer(EN),
                Handler::Act(Act::new("txn.unlink_transfer", json!({ "id": self.id }))),
            ));
        }
        menu_items.push(trash_item);
        let page_menu = blocks::menu(
            "txn/menu",
            vec![blocks::menu_section("", menu_items)],
            &mut b.sel,
        );

        let mut hero = blocks::hero(&txn.title)
            .noun(&words::txn_detail_title(EN))
            .line(&amount_str)
            .line(&format!("{} · {}", txn.posted_on, txn.account_title));
        if txn.status == "pending" {
            hero = hero.chip(blocks::chip(
                &words::pending_chip(EN),
                wire::RoomTone::Warning,
            ));
        }
        if starred {
            hero = hero.chip(blocks::chip(
                &words::starred_chip(EN),
                wire::RoomTone::Accent,
            ));
        }
        let mut blocks_out = vec![hero.block()];

        let mut facts = vec![
            blocks::fact(
                &words::field_amount(EN),
                &amount_str,
                wire::RoomFactKind::Money,
            ),
            blocks::fact(
                &words::field_account(EN),
                &txn.account_title,
                wire::RoomFactKind::Text,
            ),
            blocks::fact(
                &words::field_date(EN),
                &txn.posted_on,
                wire::RoomFactKind::Date,
            ),
            blocks::fact(
                &words::field_status(EN),
                &if txn.status == "pending" {
                    words::status_pending(EN)
                } else {
                    words::status_posted(EN)
                },
                wire::RoomFactKind::Text,
            ),
        ];
        if let (Some(orig_minor), Some(orig_cur)) =
            (txn.original_amount_minor, txn.original_currency.as_deref())
        {
            facts.push(blocks::fact(
                &words::field_currency(EN),
                &fmt_minor(orig_minor, orig_cur),
                wire::RoomFactKind::Money,
            ));
        }
        if let Some(memo) = txn.memo.as_deref().filter(|s| !s.is_empty()) {
            facts.push(blocks::fact(
                &words::field_memo(EN),
                memo,
                wire::RoomFactKind::Text,
            ));
        }
        if splits.len() == 1 {
            facts.push(blocks::fact(
                &words::field_category(EN),
                &splits[0].category_title,
                wire::RoomFactKind::Text,
            ));
        } else if splits.is_empty() {
            facts.push(blocks::fact(
                &words::field_category(EN),
                &words::uncategorized_label(EN),
                wire::RoomFactKind::Text,
            ));
        }
        blocks_out.push(blocks::facts(facts));

        if splits.len() > 1 {
            let split_rows: Vec<wire::RoomBlock> = splits
                .iter()
                .enumerate()
                .map(|(i, sp)| {
                    let mut row =
                        blocks::still_row(&mut b.sel, &format!("split/{i}"), &sp.category_title)
                            .trailing(
                                &fmt_minor(sp.amount_minor, &txn.currency),
                                wire::RoomTone::Neutral,
                            );
                    if let Some(m) = sp.memo.as_deref().filter(|s| !s.is_empty()) {
                        row = row.meta(m);
                    }
                    row.into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(&mut b.sel, "section/splits", &words::section_splits(EN))
                    .blocks(split_rows)
                    .into_block(),
            );
        }

        if let Some(tr) = transfers.first() {
            let (other_id, other_title, other_minor, other_cur, other_day) = if tr.a_id == self.id {
                (&tr.b_id, &tr.b_title, tr.b_minor, &tr.b_currency, &tr.b_day)
            } else {
                (&tr.a_id, &tr.a_title, tr.a_minor, &tr.a_currency, &tr.a_day)
            };
            let tr_row = blocks::row(
                &mut b.sel,
                &format!("transfer/{other_id}"),
                other_title,
                Handler::Open(format!("money/txn/{other_id}")),
            )
            .meta(other_day)
            .trailing(&fmt_minor(other_minor, other_cur), wire::RoomTone::Neutral)
            .into_block();
            blocks_out.push(
                blocks::section(&mut b.sel, "section/transfer", &words::section_transfer(EN))
                    .trailing(blocks::action(
                        &mut b.sel,
                        "transfer/unlink",
                        &words::menu_unlink_transfer(EN),
                        "Link",
                        Handler::Act(Act::new("txn.unlink_transfer", json!({ "id": self.id }))),
                    ))
                    .block(tr_row)
                    .into_block(),
            );
        }

        // Statement says (S3/N1): compare live values against source.stated
        if let Some(src) = sources.first() {
            let mut says_fields = Vec::new();
            if let Some(stated_title) = src.stated_title.as_deref().filter(|s| !s.is_empty())
                && stated_title != txn.title
            {
                says_fields.push(blocks::says_field(
                    &mut b.sel,
                    "says/title",
                    &words::field_title(EN),
                    stated_title,
                    &txn.title,
                    Handler::Tag(format!("take:title:{stated_title}")),
                ));
            }
            if let Ok(stated_json) = serde_json::from_str::<Value>(&src.stated) {
                if let Some(stated_minor) = stated_json.get("amount_minor").and_then(Value::as_i64)
                    && stated_minor != txn.amount_minor
                {
                    says_fields.push(blocks::says_field(
                        &mut b.sel,
                        "says/amount",
                        &words::field_amount(EN),
                        &fmt_minor(stated_minor, &txn.currency),
                        &amount_str,
                        Handler::Tag(format!("take:amount:{stated_minor}")),
                    ));
                }
                if let Some(stated_day) = stated_json.get("posted_on").and_then(Value::as_str)
                    && stated_day != txn.posted_on
                {
                    says_fields.push(blocks::says_field(
                        &mut b.sel,
                        "says/date",
                        &words::field_date(EN),
                        stated_day,
                        &txn.posted_on,
                        Handler::Tag(format!("take:date:{stated_day}")),
                    ));
                }
            }
            if !says_fields.is_empty() {
                blocks_out.push(blocks::says(
                    wire::RoomSaysSource::Statement,
                    &words::says_heading(EN),
                    says_fields,
                    &words::says_take(EN),
                ));
            }
        }

        // Attachments footer (S12: homed captures + attached edges)
        let mut att_rows = Vec::new();
        for item in &homed_photos {
            att_rows.push(
                blocks::still_row(
                    &mut b.sel,
                    &format!("capture/photo/{}", item.id),
                    &item.title,
                )
                .build(),
            );
        }
        for item in &homed_docs {
            att_rows.push(
                blocks::still_row(&mut b.sel, &format!("capture/doc/{}", item.id), &item.title)
                    .build(),
            );
        }
        for item in &attached {
            att_rows.push(
                blocks::still_row(&mut b.sel, &format!("attached/{}", item.id), &item.title)
                    .build(),
            );
        }
        let attach_menu = blocks::menu(
            "attachments/add",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "attachments/scan",
                        &words::attach_scan(EN),
                        Handler::Tag("attach:scan".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "attachments/file",
                        &words::attach_file(EN),
                        Handler::Tag("attach:file".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "attachments/photo",
                        &words::attach_photo(EN),
                        Handler::Tag("attach:photo".to_owned()),
                    ),
                ],
            )],
            &mut b.sel,
        );
        blocks_out.push(blocks::attachments(
            &words::footer_attachments(EN),
            att_rows,
            Some(attach_menu),
        ));

        let mut linked_rows = Vec::new();
        for link in &linked_ids {
            if let Ok(ans) = b.run(&reads::ENTITY_REF, &Args::new().text("id", &link.0))
                && let Some(ent) = ans.rows.into_iter().next()
            {
                linked_rows.push(
                    blocks::still_row(&mut b.sel, &format!("linked/{}", ent.id), &ent.title)
                        .meta(&ent.kind)
                        .build(),
                );
            }
        }
        blocks_out.push(blocks::linked(
            &words::footer_linked(EN),
            linked_rows,
            Some(blocks::action(
                &mut b.sel,
                "linked/add",
                &words::footer_add_link(EN),
                "Link",
                Handler::Tag("link:add".to_owned()),
            )),
        ));

        if !mentioned.is_empty() {
            let rows = mentioned
                .iter()
                .map(|m| {
                    blocks::still_row(&mut b.sel, &format!("mention/{}", m.id), &m.title).build()
                })
                .collect();
            blocks_out.push(blocks::mentioned_in(&words::footer_mentioned(EN), rows));
        }

        if rev_count > 0 {
            let count_u32 = u32::try_from(rev_count).unwrap_or(u32::MAX);
            blocks_out.push(blocks::earlier_versions(
                &mut b.sel,
                &words::versions_summary(EN, u64::from(count_u32)),
                count_u32,
                Handler::Tag("versions".to_owned()),
            ));
        }

        if let Some(via) = txn.arrived_via.as_deref() {
            let line = match (via, txn.arrived_label.as_deref()) {
                ("csv", Some(file)) if !file.is_empty() => {
                    fill(&words::origin_csv_file(EN), &[("file", file)])
                }
                ("csv", _) => words::origin_csv(EN),
                _ => words::origin_statement(EN),
            };
            blocks_out.push(blocks::origin(&mut b.sel, &line, None));
        } else if txn.entered == "statement" {
            blocks_out.push(blocks::origin(
                &mut b.sel,
                &words::origin_statement(EN),
                None,
            ));
        }

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::txn_detail_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .menu_key(&mut b.sel, "key/menu", &words::menu_more(EN), page_menu)
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "share" {
            return Outcome::say(&words::shared(EN));
        }
        if let Some(title) = tag.strip_prefix("take:title:") {
            return match e.door.act(&Act::new(
                "entity.retitle",
                json!({ "id": self.id, "title": title }),
            )) {
                Ok(done) => Outcome::done(&words::statement_taken(EN), done.undo),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if let Some(amount_str) = tag.strip_prefix("take:amount:")
            && let Ok(minor) = amount_str.parse::<i64>()
        {
            return match e.door.act(&Act::new(
                "txn.edit",
                json!({ "id": self.id, "amount_minor": minor }),
            )) {
                Ok(done) => Outcome::done(&words::statement_taken(EN), done.undo),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if let Some(day) = tag.strip_prefix("take:date:") {
            return match e.door.act(&Act::new(
                "txn.edit",
                json!({ "id": self.id, "posted_on": day }),
            )) {
                Ok(done) => Outcome::done(&words::statement_taken(EN), done.undo),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

#[derive(Clone, Default)]
struct SplitDraft {
    category_id: String,
    amount_minor: i64,
    memo: String,
}

struct TxnForm {
    editing_id: Option<String>,
    loaded: bool,
    fields: Fields,
    amount_minor: i64,
    is_income: bool,
    account_id: String,
    status: String,
    splits: Vec<SplitDraft>,
    dirty: bool,
    drafted: bool,
    confirm_discard: bool,
    error: Option<String>,
}

impl TxnForm {
    fn new_txn() -> Self {
        Self {
            editing_id: None,
            loaded: false,
            fields: Fields::default(),
            amount_minor: 0,
            is_income: false,
            account_id: String::new(),
            status: "posted".to_owned(),
            splits: Vec::new(),
            dirty: false,
            drafted: false,
            confirm_discard: false,
            error: None,
        }
    }

    fn edit_txn(id: String) -> Self {
        Self {
            editing_id: Some(id),
            ..Self::new_txn()
        }
    }

    fn persist_draft(&mut self, door: &dyn Door) {
        if self.editing_id.is_some() {
            return;
        }
        let Some(key) = draft_key(door) else {
            return;
        };
        let splits_json: Vec<Value> = self
            .splits
            .iter()
            .map(|s| {
                json!({
                    "category_id": s.category_id,
                    "amount_minor": s.amount_minor,
                    "memo": s.memo,
                })
            })
            .collect();
        let mut map = Map::new();
        map.insert("amount_minor".to_owned(), json!(self.amount_minor));
        map.insert("is_income".to_owned(), json!(self.is_income));
        map.insert("account_id".to_owned(), json!(self.account_id));
        map.insert("status".to_owned(), json!(self.status));
        map.insert(
            "title".to_owned(),
            json!(self.fields.get_or("title", "").value()),
        );
        map.insert(
            "date".to_owned(),
            json!(self.fields.get_or("date", "").value()),
        );
        map.insert(
            "memo".to_owned(),
            json!(self.fields.get_or("memo", "").value()),
        );
        map.insert("splits".to_owned(), Value::Array(splits_json));
        let payload = json!({
            "v": 1,
            "kind": "txn",
            "fields": Value::Object(map),
            "saved_at": door.now_ms(),
        });
        if door.device_put(&key, &payload.to_string()).is_ok() {
            self.drafted = true;
        }
    }

    fn clear_draft(&mut self, door: &dyn Door) {
        if let Some(key) = draft_key(door) {
            let _ = door.device_delete(&key);
        }
        self.drafted = false;
    }

    fn restore_draft(&mut self, door: &dyn Door) -> bool {
        if self.editing_id.is_some() {
            return false;
        }
        let Some(key) = draft_key(door) else {
            return false;
        };
        let Some(text) = door.device_get(&key) else {
            return false;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        let Some(fields) = parsed.get("fields").and_then(Value::as_object) else {
            return false;
        };
        if let Some(minor) = fields.get("amount_minor").and_then(Value::as_i64) {
            self.amount_minor = minor;
        }
        if let Some(inc) = fields.get("is_income").and_then(Value::as_bool) {
            self.is_income = inc;
        }
        if let Some(acc) = fields.get("account_id").and_then(Value::as_str) {
            self.account_id = acc.to_owned();
        }
        if let Some(st) = fields.get("status").and_then(Value::as_str) {
            self.status = st.to_owned();
        }
        for name in ["title", "date", "memo"] {
            if let Some(val) = fields.get(name).and_then(Value::as_str) {
                self.fields.set_str(name, val);
            }
        }
        if let Some(arr) = fields.get("splits").and_then(Value::as_array) {
            self.splits = arr
                .iter()
                .map(|item| SplitDraft {
                    category_id: item
                        .get("category_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    amount_minor: item
                        .get("amount_minor")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    memo: item
                        .get("memo")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
                .collect();
        }
        self.dirty = true;
        self.drafted = true;
        true
    }
}

impl RoomScreen for TxnForm {
    fn key(&self) -> String {
        match &self.editing_id {
            Some(id) => format!("money/txn/{id}/edit"),
            None => NEW_TXN.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let accounts = b
            .run(&reads::ACCOUNTS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let categories = b
            .run(&reads::CATEGORIES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        if !self.loaded {
            self.loaded = true;
            if let Some(id) = &self.editing_id {
                if let Ok(ans) = b.run(&reads::TXN_BY_ID, &Args::new().text("id", id))
                    && let Some(txn) = ans.rows.into_iter().next()
                {
                    self.amount_minor = txn.amount_minor.abs();
                    self.is_income = txn.amount_minor > 0;
                    self.account_id = txn.account_id;
                    self.status = txn.status;
                    self.fields.set_str("title", &txn.title);
                    self.fields.set_str("date", &txn.posted_on);
                    self.fields
                        .set_str("memo", txn.memo.as_deref().unwrap_or_default());
                }
                if let Ok(ans) = b.run(&reads::TXN_SPLITS, &Args::new().text("txn", id)) {
                    self.splits = ans
                        .rows
                        .into_iter()
                        .map(|s| SplitDraft {
                            category_id: s.category_id,
                            amount_minor: s.amount_minor.abs(),
                            memo: s.memo.unwrap_or_default(),
                        })
                        .collect();
                }
            } else {
                let restored = self.restore_draft(b.door);
                if !restored {
                    self.fields.set_str("date", &today_iso(b.door.now_ms()));
                }
                if self.account_id.is_empty() {
                    self.account_id = last_used_account(b.door)
                        .filter(|id| accounts.iter().any(|a| &a.id == id))
                        .or_else(|| accounts.first().map(|a| a.id.clone()))
                        .unwrap_or_default();
                }
            }
        }

        let title = if self.editing_id.is_some() {
            words::edit_txn_title(EN)
        } else {
            words::new_txn_title(EN)
        };

        if self.confirm_discard {
            let sheet = blocks::confirm(
                &mut b.sel,
                Confirm {
                    class: wire::RoomConfirmClass::Outlined,
                    title: &words::discard_title(EN),
                    body: &words::discard_body(EN),
                    warning: "",
                    confirm_label: &words::discard_confirm(EN),
                    confirm: Handler::Tag("discard:yes".to_owned()),
                    cancel_label: &words::discard_keep(EN),
                    cancel: Handler::Tag("discard:no".to_owned()),
                },
            );
            return room(wire::RoomKind::Sheet, &self.key())
                .title(&words::discard_title(EN))
                .ready(vec![sheet])
                .build();
        }

        let currency = accounts
            .iter()
            .find(|a| a.id == self.account_id)
            .map(|a| a.currency.clone())
            .unwrap_or_else(|| vault_currency(b));
        let exp = u32::from(fmt_money::minor_units(&currency));
        let signed_minor = if self.is_income {
            self.amount_minor
        } else {
            -self.amount_minor
        };
        let display = fmt_minor(signed_minor, &currency);

        let mut amount_field = form::money(
            &mut b.sel,
            "amount",
            &words::field_amount(EN),
            self.amount_minor,
            &currency,
            exp,
            &display,
        )
        .required();
        if self.editing_id.is_none() {
            amount_field = amount_field.focused();
        }
        if let Some(err) = &self.error {
            amount_field = amount_field.error(err);
        }

        let direction_field = form::choice(
            &mut b.sel,
            "direction",
            &words::field_direction(EN),
            wire::RoomChoiceStyle::Segmented,
            vec![
                blocks::option("expense", &words::direction_expense(EN), !self.is_income),
                blocks::option("income", &words::direction_income(EN), self.is_income),
            ],
        );

        let account_options: Vec<wire::RoomOption> = accounts
            .iter()
            .map(|a| blocks::option(&a.id, &a.title, a.id == self.account_id))
            .collect();
        let account_field = form::choice(
            &mut b.sel,
            "account",
            &words::field_account(EN),
            wire::RoomChoiceStyle::Menu,
            account_options,
        )
        .required();

        let title_field = form::text(
            &mut b.sel,
            &mut self.fields,
            "title",
            &words::field_title(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        );
        let date_field = form::text(
            &mut b.sel,
            &mut self.fields,
            "date",
            &words::field_date(EN),
            wire::RoomTextKind::Line,
            &today_iso(b.door.now_ms()),
            20,
        );
        let memo_field = form::text(
            &mut b.sel,
            &mut self.fields,
            "memo",
            &words::field_memo(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        );
        let status_field = form::choice(
            &mut b.sel,
            "status",
            &words::field_status(EN),
            wire::RoomChoiceStyle::Segmented,
            vec![
                blocks::option(
                    "posted",
                    &words::status_posted(EN),
                    self.status != "pending",
                ),
                blocks::option(
                    "pending",
                    &words::status_pending(EN),
                    self.status == "pending",
                ),
            ],
        );

        let split_groups: Vec<wire::RoomFieldGroup> = self
            .splits
            .iter()
            .enumerate()
            .map(|(i, sp)| {
                let cat_opts: Vec<wire::RoomOption> = categories
                    .iter()
                    .map(|c| blocks::option(&c.id, &c.title, c.id == sp.category_id))
                    .collect();
                let cat_field = form::choice(
                    &mut b.sel,
                    &format!("split_cat_{i}"),
                    &words::field_category(EN),
                    wire::RoomChoiceStyle::Menu,
                    cat_opts,
                )
                .build();
                let sp_display = fmt_minor(sp.amount_minor, &currency);
                let amt_field = form::money(
                    &mut b.sel,
                    &format!("split_amt_{i}"),
                    &words::field_amount(EN),
                    sp.amount_minor,
                    &currency,
                    exp,
                    &sp_display,
                )
                .build();
                form::group(
                    &format!("split/{i}"),
                    vec![cat_field, amt_field],
                    Handler::Tag(format!("split:remove:{i}")),
                    &mut b.sel,
                )
            })
            .collect();

        let splits_repeat = form::repeat(
            &mut b.sel,
            "repeat/splits",
            &words::repeat_splits(EN),
            split_groups,
            &words::add_split(EN),
            Handler::Tag("split:add".to_owned()),
        );

        let save = Save::Explicit(form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("cancel".to_owned()),
                save_enabled: self.amount_minor > 0 && !self.account_id.is_empty(),
                dirty: self.dirty,
                drafted: self.drafted,
            },
        ));

        let form_block = form::form(
            vec![
                amount_field.build(),
                direction_field.build(),
                account_field.build(),
                title_field.build(),
                date_field.build(),
                memo_field.build(),
                status_field.build(),
            ],
            vec![splits_repeat],
            save,
        );

        room(wire::RoomKind::Editor, &self.key())
            .title(&title)
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "amount" => {
                if let Input::Integer(minor) = input {
                    self.amount_minor = (*minor).abs();
                    self.dirty = true;
                    self.error = None;
                    self.persist_draft(e.door);
                }
                Outcome::default()
            }
            "direction" => {
                if let Input::Option(opt) = input {
                    self.is_income = opt == "income";
                    self.dirty = true;
                    self.persist_draft(e.door);
                }
                Outcome::default()
            }
            "account" => {
                if let Input::Option(opt) = input {
                    self.account_id = opt.clone();
                    self.dirty = true;
                    self.persist_draft(e.door);
                }
                Outcome::default()
            }
            "status" => {
                if let Input::Option(opt) = input {
                    self.status = opt.clone();
                    self.dirty = true;
                    self.persist_draft(e.door);
                }
                Outcome::default()
            }
            "title" | "date" | "memo" => {
                if let Input::Text(text) = input {
                    self.fields.set_str(tag, text);
                    self.dirty = true;
                    self.persist_draft(e.door);
                }
                Outcome::default()
            }
            "split:add" => {
                self.splits.push(SplitDraft::default());
                self.dirty = true;
                self.persist_draft(e.door);
                Outcome::default()
            }
            "cancel" => {
                if self.dirty {
                    self.confirm_discard = true;
                    Outcome::default()
                } else {
                    Outcome::pop()
                }
            }
            "discard:yes" => {
                self.confirm_discard = false;
                self.clear_draft(e.door);
                Outcome::pop()
            }
            "discard:no" => {
                self.confirm_discard = false;
                Outcome::default()
            }
            "save" => self.save(e),
            other => {
                if let Some(idx_str) = other.strip_prefix("split:remove:")
                    && let Ok(idx) = idx_str.parse::<usize>()
                    && idx < self.splits.len()
                {
                    self.splits.remove(idx);
                    self.dirty = true;
                    self.persist_draft(e.door);
                } else if let Some(idx_str) = other.strip_prefix("split_cat_")
                    && let Ok(idx) = idx_str.parse::<usize>()
                    && idx < self.splits.len()
                    && let Input::Option(opt) = input
                {
                    self.splits[idx].category_id = opt.clone();
                    self.dirty = true;
                    self.persist_draft(e.door);
                } else if let Some(idx_str) = other.strip_prefix("split_amt_")
                    && let Ok(idx) = idx_str.parse::<usize>()
                    && idx < self.splits.len()
                    && let Input::Integer(minor) = input
                {
                    self.splits[idx].amount_minor = (*minor).abs();
                    self.dirty = true;
                    self.persist_draft(e.door);
                }
                Outcome::default()
            }
        }
    }
}

impl TxnForm {
    fn save(&mut self, e: &mut Event<'_>) -> Outcome {
        if self.amount_minor <= 0 {
            self.error = Some(words::field_amount_required(EN));
            return Outcome::default();
        }
        if self.account_id.is_empty() {
            self.error = Some(words::field_account_required(EN));
            return Outcome::default();
        }
        let signed = if self.is_income {
            self.amount_minor
        } else {
            -self.amount_minor
        };
        let sign_mult: i64 = if self.is_income { 1 } else { -1 };

        let active_splits: Vec<&SplitDraft> = self
            .splits
            .iter()
            .filter(|s| !s.category_id.is_empty() && s.amount_minor > 0)
            .collect();
        if !active_splits.is_empty() {
            let sum: i64 = active_splits.iter().map(|s| s.amount_minor).sum();
            if sum != self.amount_minor {
                self.error = Some(words::field_splits_mismatch(EN));
                return Outcome::default();
            }
        }

        let splits_json: Vec<Value> = active_splits
            .iter()
            .map(|s| {
                let mut obj = json!({
                    "category_id": s.category_id,
                    "amount_minor": s.amount_minor * sign_mult,
                });
                if !s.memo.is_empty()
                    && let Some(m) = obj.as_object_mut()
                {
                    m.insert("memo".to_owned(), json!(s.memo));
                }
                obj
            })
            .collect();

        let title = self.fields.get_or("title", "").value().trim().to_owned();
        let date = self.fields.get_or("date", "").value().trim().to_owned();
        let memo = self.fields.get_or("memo", "").value().trim().to_owned();

        if let Some(id) = &self.editing_id {
            let mut input = json!({
                "id": id,
                "account_id": self.account_id,
                "posted_on": date,
                "amount_minor": signed,
                "status": self.status,
            });
            if let Some(obj) = input.as_object_mut() {
                if !memo.is_empty() {
                    obj.insert("memo".to_owned(), json!(memo));
                }
                if !splits_json.is_empty() {
                    obj.insert("splits".to_owned(), Value::Array(splits_json));
                }
            }
            if let Err(refused) = e.door.act(&Act::new("txn.edit", input)) {
                return Outcome::refuse(&refused.0);
            }
            if !title.is_empty() {
                let _ = e.door.act(&Act::new(
                    "entity.retitle",
                    json!({ "id": id, "title": title }),
                ));
            }
            save_last_used_account(e.door, &self.account_id);
            Outcome {
                nav: super::screen::Nav::Pop,
                status: Some(super::screen::Status {
                    sentence: words::txn_saved(EN),
                    undo: false,
                    refused: false,
                }),
            }
        } else {
            let id = mint_uuid_v7(e.door.now_ms());
            let mut input = json!({
                "id": id,
                "account_id": self.account_id,
                "posted_on": date,
                "amount_minor": signed,
                "status": self.status,
            });
            if let Some(obj) = input.as_object_mut() {
                if !title.is_empty() {
                    obj.insert("title".to_owned(), json!(title));
                }
                if !memo.is_empty() {
                    obj.insert("memo".to_owned(), json!(memo));
                }
                if !splits_json.is_empty() {
                    obj.insert("splits".to_owned(), Value::Array(splits_json));
                }
            }
            match e.door.act(&Act::new("txn.add", input)) {
                Ok(done) => {
                    save_last_used_account(e.door, &self.account_id);
                    self.clear_draft(e.door);
                    Outcome {
                        nav: super::screen::Nav::Pop,
                        status: Some(super::screen::Status {
                            sentence: words::txn_saved(EN),
                            undo: done.undo,
                            refused: false,
                        }),
                    }
                }
                Err(refused) => Outcome::refuse(&refused.0),
            }
        }
    }
}

struct CsvImportRoom {
    loaded: bool,
    account_id: String,
    fields: Fields,
    date_col: String,
    desc_col: String,
    amount_col: String,
    debit_col: String,
    credit_col: String,
    indicator_col: String,
    memo_col: String,
    date_order: String,
    sign_mode: String,
    file_label: String,
}

impl Default for CsvImportRoom {
    fn default() -> Self {
        Self {
            loaded: false,
            account_id: String::new(),
            fields: Fields::default(),
            date_col: String::new(),
            desc_col: String::new(),
            amount_col: String::new(),
            debit_col: String::new(),
            credit_col: String::new(),
            indicator_col: String::new(),
            memo_col: String::new(),
            date_order: "ymd".to_owned(),
            sign_mode: "signed".to_owned(),
            file_label: "statement.csv".to_owned(),
        }
    }
}

struct ParsedCsvRow {
    posted_on: String,
    title: String,
    amount_minor: i64,
    memo: Option<String>,
}

fn parse_csv_date(raw: &str, order: &str) -> Option<String> {
    let s = raw.trim();
    if s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' {
        return Some(s.to_owned());
    }
    let sep = if s.contains('/') {
        '/'
    } else if s.contains('-') {
        '-'
    } else {
        return None;
    };
    let parts: Vec<&str> = s.split(sep).collect();
    if parts.len() != 3 {
        return None;
    }
    let a: u32 = parts[0].parse().ok()?;
    let b: u32 = parts[1].parse().ok()?;
    let c: u32 = parts[2].parse().ok()?;
    let (y, m, d) = match order {
        "mdy" => (c, a, b),
        "dmy" => (c, b, a),
        _ => (a, b, c),
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1900 {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn parse_signed_minor(raw: &str, exp: u32) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let negative = s.starts_with('-');
    let unsigned = s.trim_start_matches(['-', '+']);
    let mag = fmt_money::parse(unsigned, exp)?;
    Some(if negative { -mag } else { mag })
}

impl CsvImportRoom {
    fn headers_and_rows(&self) -> (Vec<String>, Vec<Vec<String>>) {
        let text = self.fields.str_or("csv", "").to_owned();
        let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
        let Some(first) = lines.next() else {
            return (Vec::new(), Vec::new());
        };
        let headers: Vec<String> = first.split(',').map(|c| c.trim().to_owned()).collect();
        let rows: Vec<Vec<String>> = lines
            .map(|line| line.split(',').map(|c| c.trim().to_owned()).collect())
            .collect();
        (headers, rows)
    }

    fn apply_saved_layout(&mut self, config: &str) {
        let Ok(v) = serde_json::from_str::<Value>(config) else {
            return;
        };
        if let Some(s) = v.get("date_order").and_then(Value::as_str) {
            self.date_order = s.to_owned();
        }
        if let Some(s) = v.get("sign_mode").and_then(Value::as_str) {
            self.sign_mode = s.to_owned();
        }
        if let Some(s) = v.get("date_col").and_then(Value::as_str) {
            self.date_col = s.to_owned();
        }
        if let Some(s) = v.get("desc_col").and_then(Value::as_str) {
            self.desc_col = s.to_owned();
        }
        if let Some(s) = v.get("amount_col").and_then(Value::as_str) {
            self.amount_col = s.to_owned();
        }
        if let Some(s) = v.get("debit_col").and_then(Value::as_str) {
            self.debit_col = s.to_owned();
        }
        if let Some(s) = v.get("credit_col").and_then(Value::as_str) {
            self.credit_col = s.to_owned();
        }
        if let Some(s) = v.get("indicator_col").and_then(Value::as_str) {
            self.indicator_col = s.to_owned();
        }
        if let Some(s) = v.get("memo_col").and_then(Value::as_str) {
            self.memo_col = s.to_owned();
        }
    }

    fn parse_rows(&self, exp: u32) -> Result<Vec<ParsedCsvRow>, String> {
        let (headers, rows) = self.headers_and_rows();
        if headers.is_empty() || rows.is_empty() {
            return Err(words::csv_no_rows(EN));
        }
        let col_idx = |name: &str| headers.iter().position(|h| h == name);
        let Some(date_i) = col_idx(&self.date_col) else {
            return Err(words::csv_missing_date(EN));
        };
        let desc_i = col_idx(&self.desc_col);
        let memo_i = col_idx(&self.memo_col);

        let mut parsed = Vec::new();
        for row in &rows {
            let date_raw = row.get(date_i).map(String::as_str).unwrap_or_default();
            let Some(posted_on) = parse_csv_date(date_raw, &self.date_order) else {
                return Err(words::csv_bad_rows(EN));
            };
            let amount_minor = match self.sign_mode.as_str() {
                "dc" => {
                    let debit_i = col_idx(&self.debit_col);
                    let credit_i = col_idx(&self.credit_col);
                    if debit_i.is_none() && credit_i.is_none() {
                        return Err(words::csv_missing_amount(EN));
                    }
                    let debit = debit_i
                        .and_then(|i| row.get(i))
                        .and_then(|s| parse_signed_minor(s, exp))
                        .unwrap_or(0)
                        .abs();
                    let credit = credit_i
                        .and_then(|i| row.get(i))
                        .and_then(|s| parse_signed_minor(s, exp))
                        .unwrap_or(0)
                        .abs();
                    credit - debit
                }
                "indicator" => {
                    let Some(amt_i) = col_idx(&self.amount_col) else {
                        return Err(words::csv_missing_amount(EN));
                    };
                    let Some(mag) = row
                        .get(amt_i)
                        .and_then(|s| parse_signed_minor(s, exp))
                        .map(i64::abs)
                    else {
                        return Err(words::csv_bad_rows(EN));
                    };
                    let ind = col_idx(&self.indicator_col)
                        .and_then(|i| row.get(i))
                        .map(|s| s.to_ascii_lowercase())
                        .unwrap_or_default();
                    if ind.contains("dr") || ind.contains("debit") || ind.contains("out") {
                        -mag
                    } else {
                        mag
                    }
                }
                "flip" => {
                    let Some(amt_i) = col_idx(&self.amount_col) else {
                        return Err(words::csv_missing_amount(EN));
                    };
                    let Some(v) = row.get(amt_i).and_then(|s| parse_signed_minor(s, exp)) else {
                        return Err(words::csv_bad_rows(EN));
                    };
                    -v
                }
                _ => {
                    let Some(amt_i) = col_idx(&self.amount_col) else {
                        return Err(words::csv_missing_amount(EN));
                    };
                    let Some(v) = row.get(amt_i).and_then(|s| parse_signed_minor(s, exp)) else {
                        return Err(words::csv_bad_rows(EN));
                    };
                    v
                }
            };
            let title = desc_i
                .and_then(|i| row.get(i))
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| "Imported line".to_owned());
            let memo = memo_i
                .and_then(|i| row.get(i))
                .filter(|s| !s.is_empty())
                .cloned();
            parsed.push(ParsedCsvRow {
                posted_on,
                title,
                amount_minor,
                memo,
            });
        }
        Ok(parsed)
    }
}

impl RoomScreen for CsvImportRoom {
    fn key(&self) -> String {
        IMPORT_CSV.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let accounts = b
            .run(&reads::ACCOUNTS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        if !self.loaded {
            self.loaded = true;
            self.account_id = last_used_account(b.door)
                .filter(|id| accounts.iter().any(|a| &a.id == id))
                .or_else(|| accounts.first().map(|a| a.id.clone()))
                .unwrap_or_default();
            if !self.account_id.is_empty()
                && let Ok(ans) = b.run(
                    &reads::ACCOUNT_LAYOUT,
                    &Args::new().text("account", &self.account_id),
                )
                && let Some(layout) = ans.rows.into_iter().next()
                && let Some(cfg) = layout.config.as_deref()
            {
                self.apply_saved_layout(cfg);
            }
        }

        let currency = accounts
            .iter()
            .find(|a| a.id == self.account_id)
            .map(|a| a.currency.clone())
            .unwrap_or_else(|| vault_currency(b));
        let exp = u32::from(fmt_money::minor_units(&currency));

        let (headers, _) = self.headers_and_rows();
        let col_options = |selected: &str| {
            let mut opts = vec![blocks::option(
                "",
                &words::csv_none_option(EN),
                selected.is_empty(),
            )];
            for h in &headers {
                opts.push(blocks::option(h, h, h == selected));
            }
            opts
        };

        let mut blocks_out = Vec::new();

        // Account selector + CSV data input
        let acc_opts: Vec<wire::RoomOption> = accounts
            .iter()
            .map(|a| blocks::option(&a.id, &a.title, a.id == self.account_id))
            .collect();
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "csv/account",
            &words::csv_account(EN),
            wire::RoomChoiceStyle::Menu,
            false,
            acc_opts,
            "csv:account",
        )));

        // Column role choices (app-plane §11)
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "csv/date_col",
            &words::csv_date_col(EN),
            wire::RoomChoiceStyle::Menu,
            false,
            col_options(&self.date_col),
            "csv:date_col",
        )));
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "csv/desc_col",
            &words::csv_desc_col(EN),
            wire::RoomChoiceStyle::Menu,
            false,
            col_options(&self.desc_col),
            "csv:desc_col",
        )));
        if self.sign_mode == "dc" {
            blocks_out.push(blocks::choice_block(blocks::choice(
                &mut b.sel,
                "csv/debit_col",
                &words::csv_debit_col(EN),
                wire::RoomChoiceStyle::Menu,
                false,
                col_options(&self.debit_col),
                "csv:debit_col",
            )));
            blocks_out.push(blocks::choice_block(blocks::choice(
                &mut b.sel,
                "csv/credit_col",
                &words::csv_credit_col(EN),
                wire::RoomChoiceStyle::Menu,
                false,
                col_options(&self.credit_col),
                "csv:credit_col",
            )));
        } else {
            blocks_out.push(blocks::choice_block(blocks::choice(
                &mut b.sel,
                "csv/amount_col",
                &words::csv_amount_col(EN),
                wire::RoomChoiceStyle::Menu,
                false,
                col_options(&self.amount_col),
                "csv:amount_col",
            )));
            if self.sign_mode == "indicator" {
                blocks_out.push(blocks::choice_block(blocks::choice(
                    &mut b.sel,
                    "csv/indicator_col",
                    &words::csv_indicator_col(EN),
                    wire::RoomChoiceStyle::Menu,
                    false,
                    col_options(&self.indicator_col),
                    "csv:indicator_col",
                )));
            }
        }
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "csv/memo_col",
            &words::csv_memo_col(EN),
            wire::RoomChoiceStyle::Menu,
            false,
            col_options(&self.memo_col),
            "csv:memo_col",
        )));

        // Segmented choices for date_order and sign_mode (app-plane §11)
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "csv/date_order",
            &words::csv_date_order(EN),
            wire::RoomChoiceStyle::Segmented,
            false,
            vec![
                blocks::option("mdy", &words::csv_order_mdy(EN), self.date_order == "mdy"),
                blocks::option("dmy", &words::csv_order_dmy(EN), self.date_order == "dmy"),
                blocks::option("ymd", &words::csv_order_ymd(EN), self.date_order == "ymd"),
            ],
            "csv:date_order",
        )));
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "csv/sign_mode",
            &words::csv_sign_mode(EN),
            wire::RoomChoiceStyle::Segmented,
            false,
            vec![
                blocks::option(
                    "signed",
                    &words::csv_sign_signed(EN),
                    self.sign_mode == "signed",
                ),
                blocks::option("dc", &words::csv_sign_dc(EN), self.sign_mode == "dc"),
                blocks::option(
                    "indicator",
                    &words::csv_sign_indicator(EN),
                    self.sign_mode == "indicator",
                ),
                blocks::option("flip", &words::csv_sign_flip(EN), self.sign_mode == "flip"),
            ],
            "csv:sign_mode",
        )));

        let parsed = self.parse_rows(exp);
        let can_import = match &parsed {
            Ok(rows) if !rows.is_empty() && !self.account_id.is_empty() => {
                let preview: Vec<wire::RoomBlock> = rows
                    .iter()
                    .take(3)
                    .enumerate()
                    .map(|(i, row)| {
                        let tone = if row.amount_minor > 0 {
                            wire::RoomTone::Net
                        } else {
                            wire::RoomTone::Neutral
                        };
                        blocks::still_row(&mut b.sel, &format!("preview/{i}"), &row.title)
                            .meta(&row.posted_on)
                            .trailing(&fmt_minor_signed(row.amount_minor, &currency), tone)
                            .into_block()
                    })
                    .collect();
                blocks_out.push(
                    blocks::section(
                        &mut b.sel,
                        "section/preview",
                        &words::csv_preview_heading(EN),
                    )
                    .blocks(preview)
                    .into_block(),
                );
                true
            }
            Err(msg) => {
                blocks_out.push(blocks::empty(
                    glyph("Upload", "app.money"),
                    &words::csv_title(EN),
                    msg,
                    None,
                ));
                false
            }
            _ => false,
        };

        let csv_field = form::text(
            &mut b.sel,
            &mut self.fields,
            "csv",
            &words::csv_data(EN),
            wire::RoomTextKind::Paragraph,
            "",
            MAX_CSV,
        );
        let save = Save::Explicit(form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &words::csv_import_action(EN),
                save: Handler::Tag("csv:import".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("csv:cancel".to_owned()),
                save_enabled: can_import,
                dirty: !self.fields.get_or("csv", "").value().is_empty(),
                drafted: false,
            },
        ));
        blocks_out.push(form::form(vec![csv_field.build()], Vec::new(), save));

        room(wire::RoomKind::PushedPage, IMPORT_CSV)
            .title(&words::csv_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "csv" => {
                if let Input::Text(text) = input {
                    self.fields.set_str("csv", text);
                }
                Outcome::default()
            }
            "csv:account" => {
                if let Input::Option(opt) = input {
                    self.account_id = opt.clone();
                }
                Outcome::default()
            }
            "csv:date_col" => {
                if let Input::Option(opt) = input {
                    self.date_col = opt.clone();
                }
                Outcome::default()
            }
            "csv:desc_col" => {
                if let Input::Option(opt) = input {
                    self.desc_col = opt.clone();
                }
                Outcome::default()
            }
            "csv:amount_col" => {
                if let Input::Option(opt) = input {
                    self.amount_col = opt.clone();
                }
                Outcome::default()
            }
            "csv:debit_col" => {
                if let Input::Option(opt) = input {
                    self.debit_col = opt.clone();
                }
                Outcome::default()
            }
            "csv:credit_col" => {
                if let Input::Option(opt) = input {
                    self.credit_col = opt.clone();
                }
                Outcome::default()
            }
            "csv:indicator_col" => {
                if let Input::Option(opt) = input {
                    self.indicator_col = opt.clone();
                }
                Outcome::default()
            }
            "csv:memo_col" => {
                if let Input::Option(opt) = input {
                    self.memo_col = opt.clone();
                }
                Outcome::default()
            }
            "csv:date_order" => {
                if let Input::Option(opt) = input {
                    self.date_order = opt.clone();
                }
                Outcome::default()
            }
            "csv:sign_mode" => {
                if let Input::Option(opt) = input {
                    self.sign_mode = opt.clone();
                }
                Outcome::default()
            }
            "csv:cancel" => Outcome::pop(),
            "csv:import" => {
                let currency = e
                    .door
                    .reader()
                    .ok()
                    .and_then(|r| {
                        r.run(
                            &reads::ACCOUNT_BY_ID,
                            &Args::new().text("id", &self.account_id),
                        )
                        .ok()
                    })
                    .and_then(|a| a.rows.into_iter().next())
                    .map(|a| a.currency)
                    .unwrap_or_else(|| "USD".to_owned());
                let exp = u32::from(fmt_money::minor_units(&currency));
                let rows = match self.parse_rows(exp) {
                    Ok(rows) => rows,
                    Err(msg) => return Outcome::refuse(&msg),
                };
                let count = rows.len() as u64;
                for row in rows {
                    let id = mint_uuid_v7(e.door.now_ms());
                    let mut input = json!({
                        "id": id,
                        "account_id": self.account_id,
                        "posted_on": row.posted_on,
                        "amount_minor": row.amount_minor,
                        "title": row.title,
                        "arrived_via": "csv",
                        "arrived_label": self.file_label,
                    });
                    if let Some(memo) = row.memo
                        && let Some(obj) = input.as_object_mut()
                    {
                        obj.insert("memo".to_owned(), json!(memo));
                    }
                    if let Err(refused) = e.door.act(&Act::new("txn.add/csv", input)) {
                        return Outcome::refuse(&refused.0);
                    }
                }
                save_last_used_account(e.door, &self.account_id);
                Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: words::csv_imported(EN, count),
                        undo: false,
                        refused: false,
                    }),
                }
            }
            _ => Outcome::default(),
        }
    }
}

#[derive(Default)]
struct AccountsRoom;

impl RoomScreen for AccountsRoom {
    fn key(&self) -> String {
        ACCOUNTS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let active = match b.run(&reads::ACCOUNTS, &Args::new()) {
            Ok(ans) => ans.rows,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, ACCOUNTS)
                    .title(&words::accounts_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let archived = b
            .run(&reads::ACCOUNTS_ARCHIVED, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        let mut blocks_out = Vec::new();
        if active.is_empty() && archived.is_empty() {
            blocks_out.push(blocks::empty(
                glyph("Coin", "app.money"),
                &words::accounts_empty_title(EN),
                &words::accounts_empty_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "empty/add",
                    &words::add_account(EN),
                    "Plus",
                    Handler::Open(NEW_ACCOUNT.to_owned()),
                )),
            ));
        } else {
            if !active.is_empty() {
                let rows: Vec<wire::RoomBlock> = active
                    .iter()
                    .map(|acc| {
                        let after = acc.opening_on.as_deref().unwrap_or("");
                        let delta = b
                            .run(
                                &reads::ACCOUNT_BALANCE,
                                &Args::new()
                                    .text("account", &acc.id)
                                    .text("after_day", after),
                            )
                            .ok()
                            .and_then(|a| a.rows.into_iter().next())
                            .map_or(0, |r| r.total_minor);
                        let balance = acc.opening_minor + delta;
                        blocks::row(
                            &mut b.sel,
                            &format!("account/{}", acc.id),
                            &acc.title,
                            Handler::Open(format!("money/account/{}", acc.id)),
                        )
                        .meta(&format!(
                            "{} · {}",
                            account_type_label(&acc.account_type),
                            acc.currency
                        ))
                        .trailing(&fmt_minor(balance, &acc.currency), wire::RoomTone::Neutral)
                        .into_block()
                    })
                    .collect();
                blocks_out.push(
                    blocks::section(&mut b.sel, "section/active", &words::accounts_active(EN))
                        .blocks(rows)
                        .into_block(),
                );
            }
            if !archived.is_empty() {
                let rows: Vec<wire::RoomBlock> = archived
                    .iter()
                    .map(|acc| {
                        blocks::row(
                            &mut b.sel,
                            &format!("account/{}", acc.id),
                            &acc.title,
                            Handler::Open(format!("money/account/{}", acc.id)),
                        )
                        .meta(&acc.currency)
                        .dimmed()
                        .chip(blocks::chip(
                            &words::archived_chip(EN),
                            wire::RoomTone::Neutral,
                        ))
                        .into_block()
                    })
                    .collect();
                blocks_out.push(
                    blocks::section(
                        &mut b.sel,
                        "section/archived",
                        &words::accounts_archived(EN),
                    )
                    .blocks(rows)
                    .into_block(),
                );
            }
        }

        room(wire::RoomKind::PushedPage, ACCOUNTS)
            .title(&words::accounts_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_account(EN),
                Handler::Open(NEW_ACCOUNT.to_owned()),
            )
            .ready(blocks_out)
            .build()
    }
}

struct NewAccountForm {
    fields: Fields,
    account_type: String,
    dirty: bool,
}

impl Default for NewAccountForm {
    fn default() -> Self {
        Self {
            fields: Fields::default(),
            account_type: "checking".to_owned(),
            dirty: false,
        }
    }
}

impl RoomScreen for NewAccountForm {
    fn key(&self) -> String {
        NEW_ACCOUNT.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let name = form::text(
            &mut b.sel,
            &mut self.fields,
            "title",
            &words::field_account_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        )
        .required()
        .focused();
        let kind = form::choice(
            &mut b.sel,
            "type",
            &words::field_account_type(EN),
            wire::RoomChoiceStyle::Menu,
            vec![
                blocks::option(
                    "checking",
                    &words::type_checking(EN),
                    self.account_type == "checking",
                ),
                blocks::option(
                    "savings",
                    &words::type_savings(EN),
                    self.account_type == "savings",
                ),
                blocks::option(
                    "credit",
                    &words::type_credit(EN),
                    self.account_type == "credit",
                ),
                blocks::option("cash", &words::type_cash(EN), self.account_type == "cash"),
                blocks::option(
                    "investment",
                    &words::type_investment(EN),
                    self.account_type == "investment",
                ),
            ],
        );
        let default_currency = vault_currency(b);
        let currency = form::text(
            &mut b.sel,
            &mut self.fields,
            "currency",
            &words::field_currency(EN),
            wire::RoomTextKind::Line,
            &default_currency,
            3,
        );
        let save = Save::Explicit(form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("cancel".to_owned()),
                save_enabled: !self.fields.get_or("title", "").value().trim().is_empty(),
                dirty: self.dirty,
                drafted: false,
            },
        ));
        room(wire::RoomKind::Editor, NEW_ACCOUNT)
            .title(&words::new_account_title(EN))
            .ready(vec![form::form(
                vec![name.build(), kind.build(), currency.build()],
                Vec::new(),
                save,
            )])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "title" | "currency" => {
                if let Input::Text(text) = input {
                    self.fields.set_str(tag, text);
                    self.dirty = true;
                }
                Outcome::default()
            }
            "type" => {
                if let Input::Option(opt) = input {
                    self.account_type = opt.clone();
                    self.dirty = true;
                }
                Outcome::default()
            }
            "cancel" => Outcome::pop(),
            "save" => {
                let title = self.fields.get_or("title", "").value().trim().to_owned();
                let currency = self
                    .fields
                    .get_or("currency", "USD")
                    .value()
                    .trim()
                    .to_uppercase();
                let id = mint_uuid_v7(e.door.now_ms());
                match e.door.act(&Act::new(
                    "account.add",
                    json!({
                        "id": id,
                        "title": title,
                        "type": self.account_type,
                        "currency": currency,
                    }),
                )) {
                    Ok(done) => Outcome {
                        nav: super::screen::Nav::Pop,
                        status: Some(super::screen::Status {
                            sentence: words::account_saved(EN),
                            undo: done.undo,
                            refused: false,
                        }),
                    },
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct AccountDetailRoom {
    id: String,
    loaded: usize,
}

impl RoomScreen for AccountDetailRoom {
    fn key(&self) -> String {
        format!("money/account/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let acc = match b.run(&reads::ACCOUNT_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => ans.rows.into_iter().next(),
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::accounts_title(EN))
                    .back(&mut b.sel, &words::accounts_title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(acc) = acc else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::accounts_title(EN))
                .back(&mut b.sel, &words::accounts_title(EN))
                .ready(vec![blocks::empty(
                    glyph("Coin", "app.money"),
                    &words::account_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let after = acc.opening_on.as_deref().unwrap_or("");
        let bal = b
            .run(
                &reads::ACCOUNT_BALANCE,
                &Args::new()
                    .text("account", &self.id)
                    .text("after_day", after),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .unwrap_or(reads::AccountBalance {
                total_minor: 0,
                txn_count: 0,
            });
        let balance = acc.opening_minor + bal.total_minor;
        let line_count = b
            .run(
                &reads::ACCOUNT_LINES,
                &Args::new().text("account", &self.id),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or(0, |h| h.count);
        let checkpoints = b
            .run(&reads::CHECKPOINTS, &Args::new().text("account", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let txns = b
            .reload(
                &reads::TXN_BY_ACCOUNT,
                &Args::new().text("account", &self.id),
                self.loaded.max(50),
            )
            .map(|a| a.rows)
            .unwrap_or_default();

        let archived = acc.archived_at.is_some();
        let archive_act = if archived {
            Act::new(
                "flag.clear/archived",
                json!({ "flag": "archived", "ids": [self.id] }),
            )
        } else {
            Act::new(
                "flag.set/archived",
                json!({ "flag": "archived", "ids": [self.id] }),
            )
        };
        let trash_handler = if line_count > 0 {
            Handler::Open(format!("money/account/{}/trash-confirm", self.id))
        } else {
            Handler::Act(Act::new("entity.trash", json!({ "ids": [self.id] })))
        };
        let mut trash_item = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            trash_handler,
        );
        trash_item.destructive = true;
        let menu = blocks::menu(
            "account/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/currency",
                        &words::menu_currency(EN),
                        Handler::Open(format!("money/account/{}/currency", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/checkpoint",
                        &words::menu_checkpoint(EN),
                        Handler::Open(format!("money/account/{}/checkpoint", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/archive",
                        &if archived {
                            words::menu_unarchive(EN)
                        } else {
                            words::menu_archive(EN)
                        },
                        Handler::Act(archive_act),
                    ),
                    trash_item,
                ],
            )],
            &mut b.sel,
        );

        let mut hero = blocks::hero(&acc.title)
            .noun(&account_type_label(&acc.account_type))
            .line(&fmt_minor(balance, &acc.currency))
            .line(&acc.currency);
        if archived {
            hero = hero.chip(blocks::chip(
                &words::archived_chip(EN),
                wire::RoomTone::Neutral,
            ));
        }

        let mut blocks_out = vec![
            hero.block(),
            blocks::figure(
                &words::account_balance_label(EN),
                &fmt_minor(balance, &acc.currency),
                &words::txn_count(EN, u64::try_from(line_count).unwrap_or(0)),
                wire::RoomTone::Neutral,
            ),
        ];

        if !checkpoints.is_empty() {
            let cp_rows: Vec<wire::RoomBlock> = checkpoints
                .iter()
                .map(|cp| {
                    blocks::still_row(&mut b.sel, &format!("cp/{}", cp.day), &cp.day)
                        .trailing(
                            &fmt_minor(cp.balance_minor, &acc.currency),
                            wire::RoomTone::Neutral,
                        )
                        .into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/checkpoints",
                    &words::account_checkpoints_heading(EN),
                )
                .blocks(cp_rows)
                .into_block(),
            );
        }

        if !txns.is_empty() {
            let txn_rows: Vec<wire::RoomBlock> = txns
                .iter()
                .map(|t| {
                    blocks::row(
                        &mut b.sel,
                        &format!("txn/{}", t.id),
                        &t.title,
                        Handler::Open(format!("money/txn/{}", t.id)),
                    )
                    .meta(&t.posted_on)
                    .trailing(
                        &fmt_minor(t.amount_minor, &t.currency),
                        wire::RoomTone::Neutral,
                    )
                    .into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/txns",
                    &words::account_recent_heading(EN),
                )
                .blocks(txn_rows)
                .into_block(),
            );
        }

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&acc.title)
            .back(&mut b.sel, &words::accounts_title(EN))
            .menu_key(&mut b.sel, "key/menu", &words::menu_more(EN), menu)
            .ready(blocks_out)
            .build()
    }
}

struct CurrencyRoom {
    id: String,
    fields: Fields,
    confirming: bool,
}

impl CurrencyRoom {
    fn new(id: String) -> Self {
        Self {
            id,
            fields: Fields::default(),
            confirming: false,
        }
    }
}

impl RoomScreen for CurrencyRoom {
    fn key(&self) -> String {
        format!("money/account/{}/currency", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let acc = b
            .run(&reads::ACCOUNT_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next());
        let acc_name = acc
            .as_ref()
            .map(|a| a.title.clone())
            .unwrap_or_else(|| words::accounts_title(EN));
        let current = acc
            .as_ref()
            .map(|a| a.currency.clone())
            .unwrap_or_else(|| "USD".to_owned());

        let target = self
            .fields
            .get_or("currency", &current)
            .value()
            .trim()
            .to_uppercase();

        if self.confirming {
            let confirm = blocks::confirm(
                &mut b.sel,
                Confirm {
                    class: wire::RoomConfirmClass::Outlined,
                    title: &fill(&words::currency_confirm_title(EN), &[("currency", &target)]),
                    body: &fill(&words::currency_confirm_body(EN), &[("currency", &target)]),
                    warning: &fill(
                        &words::currency_confirm_warning(EN),
                        &[("account", &acc_name)],
                    ),
                    confirm_label: &words::currency_confirm_action(EN),
                    confirm: Handler::Tag("currency:apply".to_owned()),
                    cancel_label: &shared::kit_cancel(EN),
                    cancel: Handler::Tag("currency:back".to_owned()),
                },
            );
            return room(wire::RoomKind::Sheet, &self.key())
                .title(&words::currency_title(EN))
                .ready(vec![confirm])
                .build();
        }

        let field = form::text(
            &mut b.sel,
            &mut self.fields,
            "currency",
            &words::field_currency(EN),
            wire::RoomTextKind::Line,
            &current,
            3,
        )
        .required()
        .focused();
        let save = Save::Explicit(form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &words::currency_confirm_action(EN),
                save: Handler::Tag("currency:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("currency:cancel".to_owned()),
                save_enabled: target.len() == 3 && target != current,
                dirty: target != current,
                drafted: false,
            },
        ));
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::currency_title(EN))
            .ready(vec![form::form(vec![field.build()], Vec::new(), save)])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "currency" => {
                if let Input::Text(text) = input {
                    self.fields.set_str("currency", &text.to_uppercase());
                }
                Outcome::default()
            }
            "currency:confirm" => {
                self.confirming = true;
                Outcome::default()
            }
            "currency:back" => {
                self.confirming = false;
                Outcome::default()
            }
            "currency:cancel" => Outcome::pop(),
            "currency:apply" => {
                let target = self
                    .fields
                    .get_or("currency", "")
                    .value()
                    .trim()
                    .to_uppercase();
                match e.door.act(&Act::new(
                    "account.edit/currency",
                    json!({ "id": self.id, "currency": target }),
                )) {
                    Ok(done) => Outcome {
                        nav: super::screen::Nav::Pop,
                        status: Some(super::screen::Status {
                            sentence: words::currency_changed(EN),
                            undo: done.undo,
                            refused: false,
                        }),
                    },
                    Err(refused) => {
                        self.confirming = false;
                        Outcome::refuse(&refused.0)
                    }
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct CheckpointForm {
    id: String,
    fields: Fields,
    balance_minor: i64,
    loaded: bool,
}

impl CheckpointForm {
    fn new(id: String) -> Self {
        Self {
            id,
            fields: Fields::default(),
            balance_minor: 0,
            loaded: false,
        }
    }
}

impl RoomScreen for CheckpointForm {
    fn key(&self) -> String {
        format!("money/account/{}/checkpoint", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded {
            self.loaded = true;
            self.fields.set_str("day", &today_iso(b.door.now_ms()));
        }
        let currency = b
            .run(&reads::ACCOUNT_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|a| a.currency)
            .unwrap_or_else(|| vault_currency(b));
        let exp = u32::from(fmt_money::minor_units(&currency));
        let amt = form::money(
            &mut b.sel,
            "balance",
            &words::account_balance_label(EN),
            self.balance_minor,
            &currency,
            exp,
            &fmt_minor(self.balance_minor, &currency),
        )
        .focused();
        let day = form::text(
            &mut b.sel,
            &mut self.fields,
            "day",
            &words::field_date(EN),
            wire::RoomTextKind::Line,
            &today_iso(b.door.now_ms()),
            20,
        );
        let save = Save::Explicit(form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("cancel".to_owned()),
                save_enabled: true,
                dirty: true,
                drafted: false,
            },
        ));
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::checkpoint_title(EN))
            .ready(vec![form::form(
                vec![amt.build(), day.build()],
                Vec::new(),
                save,
            )])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "balance" => {
                if let Input::Integer(minor) = input {
                    self.balance_minor = *minor;
                }
                Outcome::default()
            }
            "day" => {
                if let Input::Text(text) = input {
                    self.fields.set_str("day", text);
                }
                Outcome::default()
            }
            "cancel" => Outcome::pop(),
            "save" => {
                let day = self.fields.get_or("day", "").value().trim().to_owned();
                match e.door.act(&Act::new(
                    "checkpoint.record",
                    json!({
                        "account_id": self.id,
                        "day": day,
                        "balance_minor": self.balance_minor,
                    }),
                )) {
                    Ok(done) => Outcome {
                        nav: super::screen::Nav::Pop,
                        status: Some(super::screen::Status {
                            sentence: words::checkpoint_saved(EN),
                            undo: done.undo,
                            refused: false,
                        }),
                    },
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct TrashAccountConfirm {
    id: String,
}

impl RoomScreen for TrashAccountConfirm {
    fn key(&self) -> String {
        format!("money/account/{}/trash-confirm", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let name = b
            .run(&reads::ACCOUNT_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|a| a.title)
            .unwrap_or_else(|| words::accounts_title(EN));
        let count = b
            .run(
                &reads::ACCOUNT_LINES,
                &Args::new().text("account", &self.id),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or(0, |h| u64::try_from(h.count).unwrap_or(0));
        let title = fill(&words::trash_account_title(EN), &[("name", &name)]);
        let body = fill(&words::trash_account_body(EN, count), &[("name", &name)]);
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &body,
                warning: "",
                confirm_label: &shared::trash_move(EN),
                confirm: Handler::Tag("trash:yes".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "trash:yes" {
            return match e
                .door
                .act(&Act::new("entity.trash", json!({ "ids": [self.id] })))
            {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Replace(ACCOUNTS.to_owned()),
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: done.undo,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

#[derive(Default)]
struct BudgetsRoom {
    year_month: Option<(i32, u32)>,
    category_id: String,
    amount_minor: i64,
    carry: bool,
}

impl BudgetsRoom {
    fn ym(&mut self, now_ms: i64) -> (i32, u32) {
        *self.year_month.get_or_insert_with(|| current_ym(now_ms))
    }
}

impl RoomScreen for BudgetsRoom {
    fn key(&self) -> String {
        BUDGETS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let (year, month) = self.ym(b.door.now_ms());
        let month_key = ym_string(year, month);
        let month_label = short_month_label(year, month);
        let (from_day, to_day) = month_bounds(year, month);
        let currency = vault_currency(b);
        let exp = u32::from(fmt_money::minor_units(&currency));

        let budgets = b
            .run(
                &reads::BUDGETS_FOR_MONTH,
                &Args::new().text("month", &month_key),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let categories = b
            .run(&reads::CATEGORIES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        if self.category_id.is_empty()
            && let Some(first) = categories.first()
        {
            self.category_id = first.id.clone();
        }

        let mut blocks_out = Vec::new();
        if budgets.is_empty() {
            blocks_out.push(blocks::empty(
                glyph("Sliders", "app.money"),
                &fill(&words::budgets_empty_title(EN), &[("month", &month_label)]),
                &words::budgets_empty_body(EN),
                None,
            ));
        } else {
            let rows: Vec<wire::RoomBlock> = budgets
                .iter()
                .map(|bg| {
                    let spent = b
                        .run(
                            &reads::SPENDING_BY_CATEGORY,
                            &Args::new()
                                .text("category", &bg.category_id)
                                .text("from_day", &from_day)
                                .text("to_day", &to_day),
                        )
                        .ok()
                        .and_then(|a| a.rows.into_iter().next())
                        .map_or(0, |s| (-s.total_minor).max(0));
                    let tone = if spent > bg.amount_minor {
                        wire::RoomTone::Warning
                    } else {
                        wire::RoomTone::Neutral
                    };
                    let mut row = blocks::row(
                        &mut b.sel,
                        &format!("budget/{}", bg.category_id),
                        &bg.category_title,
                        Handler::Act(Act::new(
                            "budget.set_carry",
                            json!({
                                "category_id": bg.category_id,
                                "month": bg.month,
                                "carry": !bg.carry,
                            }),
                        )),
                    )
                    .meta(&format!(
                        "{} / {}",
                        fmt_minor(spent, &currency),
                        fmt_minor(bg.amount_minor, &currency)
                    ))
                    .trailing(&fmt_minor(bg.amount_minor, &currency), tone);
                    if bg.carry {
                        row = row.chip(blocks::chip(
                            &words::budget_carry_on(EN),
                            wire::RoomTone::Accent,
                        ));
                    }
                    row.into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(&mut b.sel, "section/budgets", &month_label)
                    .blocks(rows)
                    .into_block(),
            );
        }

        if !categories.is_empty() {
            let cat_opts: Vec<wire::RoomOption> = categories
                .iter()
                .map(|c| blocks::option(&c.id, &c.title, c.id == self.category_id))
                .collect();
            let cat_field = form::choice(
                &mut b.sel,
                "category",
                &words::field_category(EN),
                wire::RoomChoiceStyle::Menu,
                cat_opts,
            );
            let amt_field = form::money(
                &mut b.sel,
                "amount",
                &words::field_amount(EN),
                self.amount_minor,
                &currency,
                exp,
                &fmt_minor(self.amount_minor, &currency),
            );
            let carry_field =
                form::toggle(&mut b.sel, "carry", &words::budget_carry_on(EN), self.carry);
            let save = Save::Explicit(form::explicit(
                &mut b.sel,
                Explicit {
                    save_label: &shared::kit_save(EN),
                    save: Handler::Tag("budget:save".to_owned()),
                    cancel_label: &shared::kit_cancel(EN),
                    cancel: Handler::Back,
                    save_enabled: !self.category_id.is_empty() && self.amount_minor >= 0,
                    dirty: self.amount_minor > 0,
                    drafted: false,
                },
            ));
            blocks_out.push(
                blocks::section(&mut b.sel, "section/set", &words::budget_set_heading(EN))
                    .block(form::form(
                        vec![cat_field.build(), amt_field.build(), carry_field.build()],
                        Vec::new(),
                        save,
                    ))
                    .into_block(),
            );
        }

        room(wire::RoomKind::PushedPage, BUDGETS)
            .title(&words::budgets_title(EN))
            .subtitle(&month_label)
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "category" => {
                if let Input::Option(opt) = input {
                    self.category_id = opt.clone();
                }
                Outcome::default()
            }
            "amount" => {
                if let Input::Integer(minor) = input {
                    self.amount_minor = (*minor).max(0);
                }
                Outcome::default()
            }
            "carry" => {
                if let Input::Flag(on) = input {
                    self.carry = *on;
                }
                Outcome::default()
            }
            "budget:save" => {
                let (y, m) = self.ym(e.door.now_ms());
                let month = ym_string(y, m);
                match e.door.act(&Act::new(
                    "budget.set",
                    json!({
                        "category_id": self.category_id,
                        "month": month,
                        "amount_minor": self.amount_minor,
                        "carry": self.carry,
                    }),
                )) {
                    Ok(done) => Outcome::done(&words::budget_saved(EN), done.undo),
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct RulesRoom {
    fields: Fields,
    match_kind: String,
    category_id: String,
}

impl Default for RulesRoom {
    fn default() -> Self {
        Self {
            fields: Fields::default(),
            match_kind: "contains".to_owned(),
            category_id: String::new(),
        }
    }
}

impl RoomScreen for RulesRoom {
    fn key(&self) -> String {
        RULES.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let categories = b
            .run(&reads::CATEGORIES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        if self.category_id.is_empty()
            && let Some(first) = categories.first()
        {
            self.category_id = first.id.clone();
        }

        let mut all_rules = Vec::new();
        for cat in &categories {
            if let Ok(ans) = b.run(
                &reads::RULES_BY_CATEGORY,
                &Args::new().text("category", &cat.id),
            ) {
                all_rules.extend(ans.rows);
            }
        }

        let mut blocks_out = Vec::new();
        if all_rules.is_empty() {
            blocks_out.push(blocks::empty(
                glyph("List", "app.money"),
                &words::rules_empty_title(EN),
                &words::rules_empty_body(EN),
                None,
            ));
        } else {
            let rows: Vec<wire::RoomBlock> = all_rules
                .iter()
                .map(|r| {
                    let pat: Value = serde_json::from_str(&r.pattern).unwrap_or(Value::Null);
                    let text = pat.get("text").and_then(Value::as_str).unwrap_or("");
                    let title = r.display_name.as_deref().unwrap_or(text);
                    blocks::still_row(&mut b.sel, &format!("rule/{}", r.id), title)
                        .meta(&format!("{text} → {}", r.category_title))
                        .swipe(
                            &mut b.sel,
                            &format!("rule/{}/delete", r.id),
                            &shared::kit_delete(EN),
                            Handler::Act(Act::new("rule.delete", json!({ "id": r.id }))),
                        )
                        .into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(&mut b.sel, "section/rules", &words::rules_title(EN))
                    .trailing(blocks::action(
                        &mut b.sel,
                        "rules/apply",
                        &words::apply_rules(EN),
                        "CheckCircle",
                        Handler::Act(Act::new("rule.apply", json!({}))),
                    ))
                    .blocks(rows)
                    .into_block(),
            );
        }

        if !categories.is_empty() {
            let match_field = form::choice(
                &mut b.sel,
                "match",
                &words::field_rule_match(EN),
                wire::RoomChoiceStyle::Segmented,
                vec![
                    blocks::option(
                        "contains",
                        &words::match_contains(EN),
                        self.match_kind == "contains",
                    ),
                    blocks::option("is", &words::match_is(EN), self.match_kind == "is"),
                    blocks::option(
                        "matches",
                        &words::match_matches(EN),
                        self.match_kind == "matches",
                    ),
                ],
            );
            let text_field = form::text(
                &mut b.sel,
                &mut self.fields,
                "text",
                &words::field_rule_text(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_TEXT,
            )
            .required();
            let display_field = form::text(
                &mut b.sel,
                &mut self.fields,
                "display",
                &words::field_rule_display(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_TEXT,
            );
            let cat_opts: Vec<wire::RoomOption> = categories
                .iter()
                .map(|c| blocks::option(&c.id, &c.title, c.id == self.category_id))
                .collect();
            let cat_field = form::choice(
                &mut b.sel,
                "category",
                &words::field_category(EN),
                wire::RoomChoiceStyle::Menu,
                cat_opts,
            );
            let save = Save::Explicit(form::explicit(
                &mut b.sel,
                Explicit {
                    save_label: &shared::kit_save(EN),
                    save: Handler::Tag("rule:add".to_owned()),
                    cancel_label: &shared::kit_cancel(EN),
                    cancel: Handler::Back,
                    save_enabled: !self.fields.get_or("text", "").value().trim().is_empty()
                        && !self.category_id.is_empty(),
                    dirty: !self.fields.get_or("text", "").value().is_empty(),
                    drafted: false,
                },
            ));
            blocks_out.push(
                blocks::section(&mut b.sel, "section/add", &words::rule_add_heading(EN))
                    .block(form::form(
                        vec![
                            match_field.build(),
                            text_field.build(),
                            display_field.build(),
                            cat_field.build(),
                        ],
                        Vec::new(),
                        save,
                    ))
                    .into_block(),
            );
        }

        room(wire::RoomKind::PushedPage, RULES)
            .title(&words::rules_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "match" => {
                if let Input::Option(opt) = input {
                    self.match_kind = opt.clone();
                }
                Outcome::default()
            }
            "category" => {
                if let Input::Option(opt) = input {
                    self.category_id = opt.clone();
                }
                Outcome::default()
            }
            "text" | "display" => {
                if let Input::Text(text) = input {
                    self.fields.set_str(tag, text);
                }
                Outcome::default()
            }
            "rule:add" => {
                let text = self.fields.get_or("text", "").value().trim().to_owned();
                let display = self.fields.get_or("display", "").value().trim().to_owned();
                let id = mint_uuid_v7(e.door.now_ms());
                let mut input = json!({
                    "id": id,
                    "match": self.match_kind,
                    "text": text,
                    "category_id": self.category_id,
                });
                if !display.is_empty()
                    && let Some(obj) = input.as_object_mut()
                {
                    obj.insert("display_name".to_owned(), json!(display));
                }
                match e.door.act(&Act::new("rule.add", input)) {
                    Ok(done) => {
                        self.fields.set_str("text", "");
                        self.fields.set_str("display", "");
                        Outcome::done(&words::rule_saved(EN), done.undo)
                    }
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

#[derive(Default)]
struct CategoriesRoom {
    fields: Fields,
}

impl RoomScreen for CategoriesRoom {
    fn key(&self) -> String {
        CATEGORIES.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let categories = b
            .run(&reads::CATEGORIES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        let mut blocks_out = Vec::new();
        if categories.is_empty() {
            blocks_out.push(blocks::empty(
                glyph("Tag", "app.money"),
                &words::categories_empty_title(EN),
                &words::categories_empty_body(EN),
                None,
            ));
        } else {
            let rows: Vec<wire::RoomBlock> = categories
                .iter()
                .map(|c| {
                    let menu = blocks::menu(
                        &format!("cat/{}/menu", c.id),
                        vec![blocks::menu_section(
                            "",
                            vec![blocks::menu_item(
                                &mut b.sel,
                                &format!("cat/{}/merge", c.id),
                                &words::menu_merge(EN),
                                Handler::Open(format!("money/category/{}/merge", c.id)),
                            )],
                        )],
                        &mut b.sel,
                    );
                    blocks::still_row(&mut b.sel, &format!("cat/{}", c.id), &c.title)
                        .menu(menu)
                        .into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/categories",
                    &words::categories_title(EN),
                )
                .blocks(rows)
                .into_block(),
            );
        }

        let name = form::text(
            &mut b.sel,
            &mut self.fields,
            "name",
            &words::field_category_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        )
        .required();
        let save = Save::Explicit(form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("category:add".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: !self.fields.get_or("name", "").value().trim().is_empty(),
                dirty: !self.fields.get_or("name", "").value().is_empty(),
                drafted: false,
            },
        ));
        blocks_out.push(
            blocks::section(&mut b.sel, "section/add", &words::category_add_heading(EN))
                .block(form::form(vec![name.build()], Vec::new(), save))
                .into_block(),
        );

        room(wire::RoomKind::PushedPage, CATEGORIES)
            .title(&words::categories_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "name" => {
                if let Input::Text(text) = input {
                    self.fields.set_str("name", text);
                }
                Outcome::default()
            }
            "category:add" => {
                let title = self.fields.get_or("name", "").value().trim().to_owned();
                let id = mint_uuid_v7(e.door.now_ms());
                match e.door.act(&Act::new(
                    "category.add",
                    json!({ "id": id, "title": title }),
                )) {
                    Ok(done) => {
                        self.fields.set_str("name", "");
                        Outcome::done(&words::category_saved(EN), done.undo)
                    }
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct CategoryMergePick {
    id: String,
}

impl RoomScreen for CategoryMergePick {
    fn key(&self) -> String {
        format!("money/category/{}/merge", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let categories = b
            .run(&reads::CATEGORIES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let name = categories
            .iter()
            .find(|c| c.id == self.id)
            .map(|c| c.title.clone())
            .unwrap_or_default();
        let rows: Vec<wire::RoomBlock> = categories
            .iter()
            .filter(|c| c.id != self.id)
            .map(|c| {
                blocks::row(
                    &mut b.sel,
                    &format!("merge/{}", c.id),
                    &c.title,
                    Handler::Open(format!("money/category/{}/merge/{}", self.id, c.id)),
                )
                .into_block()
            })
            .collect();
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::category_merge_title(EN))
            .back(&mut b.sel, &words::categories_title(EN))
            .ready(vec![
                blocks::section(
                    &mut b.sel,
                    "section/pick",
                    &fill(&words::category_merge_pick(EN), &[("name", &name)]),
                )
                .blocks(rows)
                .into_block(),
            ])
            .build()
    }
}

struct CategoryMergeConfirm {
    from: String,
    into: String,
}

impl RoomScreen for CategoryMergeConfirm {
    fn key(&self) -> String {
        format!("money/category/{}/merge/{}", self.from, self.into)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_name = b
            .run(&reads::ENTITY_REF, &Args::new().text("id", &self.from))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|r| r.title)
            .unwrap_or_else(|| self.from.clone());
        let into_name = b
            .run(&reads::ENTITY_REF, &Args::new().text("id", &self.into))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|r| r.title)
            .unwrap_or_else(|| self.into.clone());
        let title = fill(
            &words::category_merge_confirm_title(EN),
            &[("from", &from_name), ("into", &into_name)],
        );
        let body = fill(
            &words::category_merge_confirm_body(EN),
            &[("from", &from_name), ("into", &into_name)],
        );
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &body,
                warning: "",
                confirm_label: &words::menu_merge(EN),
                confirm: Handler::Tag("merge:yes".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "merge:yes" {
            return match e.door.act(&Act::new(
                "concept.merge",
                json!({ "from": self.from, "into": self.into }),
            )) {
                Ok(_) => Outcome {
                    nav: super::screen::Nav::Replace(CATEGORIES.to_owned()),
                    status: Some(super::screen::Status {
                        sentence: words::category_merge_done(EN),
                        undo: false,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

#[derive(Default)]
struct TransfersRoom;

impl RoomScreen for TransfersRoom {
    fn key(&self) -> String {
        TRANSFERS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let pairs = b
            .run(&reads::TRANSFERS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let blocks_out = if pairs.is_empty() {
            vec![blocks::empty(
                glyph("Repeat", "app.money"),
                &words::transfers_empty_title(EN),
                &words::transfers_empty_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = pairs
                .iter()
                .map(|p| {
                    let menu = blocks::menu(
                        &format!("tr/{}/menu", p.a_id),
                        vec![blocks::menu_section(
                            "",
                            vec![blocks::menu_item(
                                &mut b.sel,
                                &format!("tr/{}/unlink", p.a_id),
                                &words::menu_unlink_transfer(EN),
                                Handler::Act(Act::new(
                                    "txn.unlink_transfer",
                                    json!({ "id": p.a_id }),
                                )),
                            )],
                        )],
                        &mut b.sel,
                    );
                    blocks::row(
                        &mut b.sel,
                        &format!("tr/{}", p.a_id),
                        &format!("{} ↔ {}", p.a_title, p.b_title),
                        Handler::Open(format!("money/txn/{}", p.a_id)),
                    )
                    .meta(&format!("{} · {}", p.a_day, p.b_day))
                    .trailing(
                        &fmt_minor(p.a_minor.abs(), &p.a_currency),
                        wire::RoomTone::Neutral,
                    )
                    .menu(menu)
                    .into_block()
                })
                .collect();
            vec![
                blocks::section(&mut b.sel, "section/transfers", &words::transfers_title(EN))
                    .blocks(rows)
                    .into_block(),
            ]
        };
        room(wire::RoomKind::PushedPage, TRANSFERS)
            .title(&words::transfers_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }
}

#[derive(Default)]
struct DismissalsRoom;

impl RoomScreen for DismissalsRoom {
    fn key(&self) -> String {
        DISMISSALS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let rows_data = b
            .run(&reads::MATCH_DISMISSALS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let blocks_out = if rows_data.is_empty() {
            vec![blocks::empty(
                glyph("Link", "app.money"),
                &words::dismissals_empty_title(EN),
                &words::dismissals_empty_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = rows_data
                .iter()
                .map(|d| {
                    blocks::still_row(
                        &mut b.sel,
                        &format!("dismiss/{}/{}", d.statement_id, d.hand_id),
                        &format!("{} ≠ {}", d.hand_title, d.statement_title),
                    )
                    .meta(&format!("{} · {}", d.hand_day, d.statement_day))
                    .trailing(
                        &fmt_minor(d.amount_minor, &d.currency),
                        wire::RoomTone::Neutral,
                    )
                    .into_block()
                })
                .collect();
            vec![
                blocks::section(
                    &mut b.sel,
                    "section/dismissals",
                    &words::dismissals_title(EN),
                )
                .blocks(rows)
                .into_block(),
            ]
        };
        room(wire::RoomKind::PushedPage, DISMISSALS)
            .title(&words::dismissals_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }
}

#[derive(Default)]
struct MoneyTrash {
    loaded: usize,
}

impl RoomScreen for MoneyTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let answer = match b.reload(&reads::TRASH, &Args::new(), self.loaded.max(50)) {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&shared::trash_entry(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count = answer.rows.len() as u64;
        let heading = format!("{} · {count}", shared::trash_title(EN));
        let blocks_out = if answer.rows.is_empty() {
            vec![blocks::empty(
                glyph("Trash", ""),
                &shared::trash_empty_headline(EN),
                "",
                None,
            )]
        } else {
            let rows: Vec<wire::RoomTrashRow> = answer
                .rows
                .iter()
                .map(|row| {
                    let deleted = row.deleted_at.get(..10).unwrap_or(&row.deleted_at);
                    let erased = row.purge_at.get(..10).unwrap_or(&row.purge_at);
                    let meta = format!(
                        "{} {deleted} · {} {erased}",
                        shared::trash_deleted(EN),
                        shared::trash_erased(EN)
                    );
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", row.id),
                        &row.title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [row.id] }))),
                        Handler::Open(format!("money/trash/purge/{}", row.id)),
                    )
                })
                .collect();
            let empty_action = blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("money/trash/empty".to_owned()),
            );
            vec![blocks::trash_block(blocks::trash(
                &heading,
                &shared::trash_entry_meta(EN),
                rows,
                Some(empty_action),
            ))]
        };
        room(wire::RoomKind::PushedPage, TRASH)
            .title(&heading)
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }
}

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("money/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = fill(&shared::trash_purge_title(EN), &[("noun", "transaction")]);
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &words::purge_body(EN),
                warning: "",
                confirm_label: &shared::trash_purge(EN),
                confirm: Handler::Tag("purge:yes".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "purge:yes" {
            return match e
                .door
                .act(&Act::new("entity.purge", json!({ "id": self.id })))
            {
                Ok(_) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: words::purged(EN),
                        undo: false,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "money/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: "",
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("empty:yes".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, "money/trash/empty")
            .title(&shared::trash_empty_title(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "empty:yes" {
            return match e.door.act(&Act::new(
                "entity.empty_trash",
                json!({ "kinds": ["account", "txn"] }),
            )) {
                Ok(_) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: words::trash_emptied(EN),
                        undo: false,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}
