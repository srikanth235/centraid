//! MONEY ADOPTS THE UNIFORM TRASH RULE (#1185): a transaction moves to trash from its page with a
//! status line and Undo, replacing the final void as the member's way to remove a line. A trashed
//! line leaves every balance, total, recurring charge and search result, comes back exactly on a
//! restore, is deleted forever or emptied from the trash behind the kit's confirms, and the trash is
//! reached from More.
//!
//! Everything is seeded at one fixed instant (`Driver::with_runtime_at`) and the lines this file
//! imports are dated from the vault's own `today`, so no assertion turns on the day the suite runs;
//! no assertion is on a duration: only on counts and values.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::kit::civil;
use centraid_screens::money::{self, fold, routes};
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use money_support::*;
use serde_json::json;
use wire::app_query_response::Answer;
use wire::money_transaction_event as te;
use wire::screen_event::Kind as E;
use wire::trash_event::{self as tr, Kind as T};

/// Monday 9 November 2026, 09:00 UTC: the instant the example scenario is seeded as of.
const NOW: i64 = 1_794_214_800_000;

fn seeded() -> Driver {
    let mut d = Driver::with_runtime_at(money::runtime(), NOW);
    d.start();
    d
}

fn command(d: &Driver, name: &str, input: serde_json::Value) -> serde_json::Value {
    static KEYS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let key = format!(
        "money-trash-{}",
        KEYS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let outcome = d
        .handle
        .command(name, &input, &key)
        .expect("the command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

/// The vault clock's day, the first of its month and the first of the months before it.
fn today(d: &Driver) -> String {
    match load_answer(
        d,
        load::money::Spending {
            month: String::new(),
        },
    ) {
        Answer::MoneySpending(spending) => spending.today,
        other => panic!("spending answered {other:?}"),
    }
}

fn first_of(today: &str, months_back: i64) -> String {
    format!("{}-01", fold::shift_month(&today[..7], -months_back))
}

/// A statement line of the account `tr`, as the follow engine takes it.
fn import(d: &Driver, lines: &[(&str, &str, i64, &str)]) {
    let records: Vec<serde_json::Value> = lines
        .iter()
        .map(|(external, day, amount, words)| {
            json!({
                "external_id": external,
                "fields": {
                    "title": words, "posted_on": day, "amount_minor": amount,
                    "line": { "memo": "m", "imported_from": "csv" },
                }
            })
        })
        .collect();
    command(
        d,
        "follow.statement",
        json!({ "origin": { "ref": "tr", "label": "Statement", "fills": "tr" }, "records": records }),
    );
}

/// The id of the line of `account` the bank wrote as `raw` in the month `months_back` before this one.
fn line(d: &Driver, raw: &str, months_back: i64) -> String {
    let today = today(d);
    let month = first_of(&today, months_back)[..7].to_owned();
    let Answer::MoneyActivity(activity) = load_answer(
        d,
        load::money::Activity {
            month,
            account_id: Some("tr".to_owned()),
            limit: 50,
            ..Default::default()
        },
    ) else {
        panic!("not activity");
    };
    activity
        .rows
        .into_iter()
        .find(|row| row.raw == raw)
        .map(|row| row.txn_id)
        .unwrap_or_else(|| panic!("no line {raw}"))
}

/// Three monthly charges and a one-off, in an account of its own; returns the one-off's id.
fn arrange(d: &Driver) -> String {
    let today = today(d);
    command(
        d,
        "account.add",
        json!({ "id": "tr", "title": "Trash test", "type": "checking", "currency": "USD" }),
    );
    import(
        d,
        &[
            ("tr:s0", &first_of(&today, 2), -1_599, "ZZSTREAMCO MONTHLY"),
            ("tr:s1", &first_of(&today, 1), -1_599, "ZZSTREAMCO MONTHLY"),
            ("tr:s2", &first_of(&today, 0), -1_599, "ZZSTREAMCO MONTHLY"),
            ("tr:one", &first_of(&today, 0), -4_250, "QQBISTRO CAFE"),
        ],
    );
    line(d, "QQBISTRO CAFE", 0)
}

struct Figures {
    balance: i64,
    spent: i64,
    month_rows: usize,
    recurring: usize,
    found: u32,
}

fn figures(d: &Driver) -> Figures {
    let today = today(d);
    let month = today[..7].to_owned();
    let Answer::MoneyAccounts(accounts) = load_answer(d, load::money::Accounts {}) else {
        panic!("not the accounts");
    };
    let balance = accounts
        .on_budget
        .iter()
        .chain(&accounts.off_budget)
        .find(|line| line.account_id == "tr")
        .and_then(|line| line.balance.as_ref())
        .map_or(0, |amount| amount.minor);
    let Answer::MoneySpending(spending) = load_answer(
        d,
        load::money::Spending {
            month: month.clone(),
        },
    ) else {
        panic!("not spending");
    };
    let spent = spending
        .per_currency
        .first()
        .and_then(|hero| hero.spent.as_ref())
        .map_or(0, |amount| amount.minor);
    let Answer::MoneyActivity(activity) = load_answer(
        d,
        load::money::Activity {
            month: month.clone(),
            account_id: Some("tr".to_owned()),
            limit: 50,
            ..Default::default()
        },
    ) else {
        panic!("not activity");
    };
    let Answer::MoneyRecurring(recurring) = load_answer(d, load::money::Recurring {}) else {
        panic!("not recurring");
    };
    let Answer::MoneySearch(search) = load_answer(
        d,
        load::money::Search {
            month,
            term: "QQBISTRO".to_owned(),
            limit: 20,
        },
    ) else {
        panic!("not search");
    };
    Figures {
        balance,
        spent,
        month_rows: activity.rows.len(),
        recurring: recurring
            .series
            .iter()
            .filter(|line| line.merchant.to_uppercase().contains("ZZSTREAMCO"))
            .count(),
        found: search.total_matches,
    }
}

fn txn_event(d: &mut Driver, page: u64, kind: te::Kind) {
    d.send(
        page,
        E::MoneyTransaction(wire::MoneyTransactionEvent { kind: Some(kind) }),
    );
}

fn txn_state(d: &Driver, page: u64) -> &wire::MoneyTransactionState {
    match &d.view(page).kind {
        Some(wire::view_state::Kind::MoneyTransaction(state)) => state,
        other => panic!("not a transaction: {other:?}"),
    }
}

fn trash_view(d: &Driver, page: u64) -> &wire::TrashView {
    match &d.view(page).kind {
        Some(wire::view_state::Kind::Trash(view)) => view,
        other => panic!("not the trash: {other:?}"),
    }
}

fn rows(d: &Driver, page: u64) -> Vec<wire::TrashRow> {
    let view = trash_view(d, page);
    match &view.content {
        Some(wire::trash_view::Content::Data(data)) => data.rows.clone(),
        // A trash with nothing in it is the empty page and carries no rows.
        None if matches!(
            view.page.as_ref().and_then(|page| page.state.as_ref()),
            Some(wire::page_state::State::Empty(_))
        ) =>
        {
            Vec::new()
        }
        other => panic!("the trash has no data: {other:?}"),
    }
}

fn send_trash(d: &mut Driver, page: u64, kind: T) {
    d.send(page, E::Trash(wire::TrashEvent { kind: Some(kind) }));
}

fn pick_trash() -> te::Kind {
    te::Kind::Action(te::ActionPicked {
        key: "trash".to_owned(),
    })
}

#[test]
fn the_transaction_page_offers_move_to_trash_and_it_asks_nothing() {
    let mut d = seeded();
    let id = arrange(&d);
    let page = push(&mut d, routes::transaction(&id, "Money"));
    let Some(wire::money_transaction_state::Content::Data(data)) = &txn_state(&d, page).content
    else {
        panic!("no data");
    };
    let trash = data
        .actions
        .iter()
        .find(|action| action.key == "trash")
        .expect("Move to trash");
    assert_eq!(
        (trash.label.as_str(), trash.icon_key.as_str()),
        ("Move to trash", "Trash")
    );
    assert!(trash.enabled && trash.destructive);
    assert!(
        data.actions.iter().all(|action| action.key != "void"),
        "no void control is left"
    );
    txn_event(&mut d, page, pick_trash());
    // The page is the line's gone state, with the line over it: nothing was asked.
    assert!(txn_state(&d, page).status.is_some());
}

#[test]
fn a_trashed_line_leaves_every_figure_and_a_restore_brings_each_back_exactly() {
    let mut d = seeded();
    let id = arrange(&d);
    let before = figures(&d);
    assert_eq!(before.balance, -(3 * 1_599 + 4_250));
    assert_eq!(before.month_rows, 2, "this month's charge and the one-off");
    assert_eq!(before.recurring, 1, "three monthly charges are a series");
    assert_eq!(before.found, 1);

    let page = push(&mut d, routes::transaction(&id, "Money"));
    txn_event(&mut d, page, pick_trash());
    let line = txn_state(&d, page).status.clone().expect("a status line");
    assert_eq!(line.sentence, "QQBISTRO CAFE moved to trash");
    assert_eq!(line.action_label, "Undo");
    assert!(!line.refused);
    let state = txn_state(&d, page);
    assert!(
        state.content.is_none(),
        "a line that is gone shows nothing of it"
    );
    let Some(wire::page_state::State::Failed(gone)) =
        state.page.as_ref().and_then(|page| page.state.as_ref())
    else {
        panic!("the page is not the gone failure");
    };
    assert_eq!(gone.sentence, "This transaction is no longer here.");
    assert!(gone.permanent, "trying again cannot bring it back");

    // The balance, the month's spending, the month's rows and the search lose it.
    let after = figures(&d);
    assert_eq!(after.balance, before.balance + 4_250);
    assert_eq!(after.spent, before.spent - 4_250);
    assert_eq!(after.month_rows, 1);
    assert_eq!(after.found, 0);
    assert_eq!(
        after.recurring, 1,
        "the series is a different line, untouched"
    );

    // Undo restores it, and every figure is back as it was.
    txn_event(&mut d, page, te::Kind::StatusActed(te::StatusActed {}));
    let line = txn_state(&d, page).status.clone().expect("a status line");
    assert_eq!(line.sentence, "Undone");
    assert_eq!(line.action_label, "", "an Undo offers nothing more");
    let restored = figures(&d);
    assert_eq!(
        (
            restored.balance,
            restored.spent,
            restored.month_rows,
            restored.found
        ),
        (
            before.balance,
            before.spent,
            before.month_rows,
            before.found
        )
    );
    // Nothing is on offer any more: a second tap changes nothing.
    txn_event(&mut d, page, te::Kind::StatusActed(te::StatusActed {}));
    assert_eq!(figures(&d).balance, before.balance);
}

#[test]
fn a_recurring_charge_the_trash_breaks_is_no_longer_detected_and_returns_on_restore() {
    let d = seeded();
    arrange(&d);
    assert_eq!(figures(&d).recurring, 1);
    let third = line(&d, "ZZSTREAMCO MONTHLY", 0);
    command(&d, "entity.trash", json!({ "id": third }));
    assert_eq!(
        figures(&d).recurring,
        0,
        "two charges are not a series, so detection no longer finds it"
    );
    command(&d, "entity.restore", json!({ "id": third }));
    assert_eq!(figures(&d).recurring, 1);
}

#[test]
fn the_trash_lists_the_line_with_the_days_the_vault_stamped_and_restores_it() {
    let mut d = seeded();
    let id = arrange(&d);
    let page = push(&mut d, routes::transaction(&id, "Money"));
    txn_event(&mut d, page, pick_trash());
    let shelf = push(&mut d, routes::trash());
    let found = rows(&d, shelf);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, id);
    assert_eq!(found[0].title, "QQBISTRO CAFE");
    let today = today(&d);
    let erased = civil::plus_days(&today, 30).expect("a day");
    assert_eq!(
        found[0].meta,
        format!(
            "Deleted {} · Erased {}",
            civil::day_month(Locale::En, &today),
            civil::day_month(Locale::En, &erased)
        )
    );
    assert_eq!(trash_view(&d, shelf).title, "Trash");
    assert_eq!(trash_view(&d, shelf).back_label, "Money");

    send_trash(
        &mut d,
        shelf,
        T::Restore(tr::RestoreTapped { id: id.clone() }),
    );
    assert_eq!(
        trash_view(&d, shelf).status.as_ref().unwrap().sentence,
        "QQBISTRO CAFE restored"
    );
    assert!(rows(&d, shelf).is_empty());
    assert_eq!(figures(&d).month_rows, 2);
}

#[test]
fn the_trash_deletes_forever_and_empties_in_the_shared_words() {
    let mut d = seeded();
    let id = arrange(&d);
    let other = line(&d, "ZZSTREAMCO MONTHLY", 0);
    for trashed in [&id, &other] {
        command(&d, "entity.trash", json!({ "id": trashed }));
    }
    let shelf = push(&mut d, routes::trash());
    assert_eq!(rows(&d, shelf).len(), 2);

    // Delete forever asks first, in the kit's sentences with the noun, and writes only when confirmed.
    send_trash(&mut d, shelf, T::Purge(tr::PurgeTapped { id: id.clone() }));
    let confirm = trash_view(&d, shelf).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Delete this transaction forever?");
    assert_eq!(
        confirm.body,
        "It leaves this vault for good. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Delete forever");
    assert!(confirm.destructive);
    send_trash(&mut d, shelf, T::Dismissed(tr::Dismissed {}));
    assert_eq!(rows(&d, shelf).len(), 2, "nothing was written");
    send_trash(&mut d, shelf, T::Purge(tr::PurgeTapped { id: id.clone() }));
    send_trash(&mut d, shelf, T::Confirmed(tr::Confirmed {}));
    assert_eq!(rows(&d, shelf).len(), 1);
    assert!(rows(&d, shelf).iter().all(|row| row.id != id));

    // Empty trash asks too, and removes everything that is left.
    send_trash(&mut d, shelf, T::Empty(tr::EmptyTapped {}));
    let confirm = trash_view(&d, shelf).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Empty trash?");
    assert_eq!(confirm.confirm_label, "Empty trash");
    send_trash(&mut d, shelf, T::Confirmed(tr::Confirmed {}));
    assert!(rows(&d, shelf).is_empty());
    assert_eq!(
        figures(&d).balance,
        -(2 * 1_599),
        "two of the four lines remain"
    );
}

#[test]
fn more_holds_the_trash_after_import() {
    let mut d = seeded();
    let home = home(&d);
    event(
        &mut d,
        home,
        home_event(wire::money_home_event::Kind::MoreOpened(
            wire::money_home_event::MoreOpened {},
        )),
    );
    let chrome = home_state(d.view(home)).chrome.clone().expect("chrome");
    let row = chrome.more_rows.last().expect("a row");
    assert_eq!(
        (row.label.as_str(), row.meta.as_str(), row.icon_key.as_str()),
        ("Trash", "30 days, then erased", "Trash")
    );
    assert_eq!(row.route.as_ref().unwrap().screen, "money.trash");
    let labels: Vec<&str> = chrome.more_rows.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "Accounts",
            "Rules",
            "Categories",
            "Import statement",
            "Export",
            "Trash"
        ]
    );
}
