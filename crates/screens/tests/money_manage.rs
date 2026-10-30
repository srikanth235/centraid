//! Accounts, categories and rules: lists, sheets and the writes behind them.
//! Ports of the matching cases of `MoneyScreensSpec`.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::money::routes;
use centraid_screens::testing::Driver;
use money_support::*;
use wire::money_accounts_event as ae;
use wire::money_categories_event as ce;
use wire::money_rules_event as re;

// --- accounts ----------------------------------------------------------------

fn acc(v: &wire::ViewState) -> &wire::MoneyAccountsState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyAccounts(s)) => s,
        other => panic!("not accounts: {other:?}"),
    }
}

fn acc_data(v: &wire::ViewState) -> &wire::MoneyAccountsData {
    match &acc(v).content {
        Some(wire::money_accounts_state::Content::Data(d)) => d,
        other => panic!("no accounts data: {other:?}"),
    }
}

fn aev(kind: ae::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneyAccounts(wire::MoneyAccountsEvent { kind: Some(kind) })
}

fn names(v: &wire::ViewState) -> Vec<String> {
    acc_data(v)
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .map(|r| r.name.clone())
        .collect()
}

#[test]
fn accounts_are_listed_with_balances_per_account_and_net_worth_per_currency() {
    let mut d = driver();
    let i = push(&mut d, routes::accounts("Money"));
    assert_eq!(acc(d.view(i)).chrome.as_ref().unwrap().title, "Accounts");
    let data = acc_data(d.view(i));
    assert_eq!(data.sections[0].title, "On budget");
    assert!(!data.net_worth.is_empty());
    assert_eq!(data.net_worth_label, "Net worth");
    for row in data.sections.iter().flat_map(|s| &s.rows) {
        assert!(!row.checkpoint_line.is_empty());
        assert!(row.meta.contains('·') || !row.meta.is_empty());
    }
}

#[test]
fn adding_an_account_needs_a_name_and_a_real_currency_then_commits() {
    let mut d = driver();
    let i = push(&mut d, routes::accounts("Money"));
    let before = names(d.view(i)).len();
    event(&mut d, i, aev(ae::Kind::Add(ae::AddTapped {})));
    let editor = acc(d.view(i)).editor.clone().expect("an editor");
    assert_eq!(editor.title, "Add an account");
    assert!(!editor.can_save);
    assert!(
        editor.issue.is_empty(),
        "an untouched sheet is not yet an error"
    );
    event(
        &mut d,
        i,
        aev(ae::Kind::Name(ae::NameEdited {
            text: "Holiday fund".into(),
        })),
    );
    event(
        &mut d,
        i,
        aev(ae::Kind::Currency(ae::CurrencyEdited { text: "us".into() })),
    );
    let editor = acc(d.view(i)).editor.clone().unwrap();
    assert_eq!(editor.issue, "Use a three-letter code, such as USD.");
    assert!(!editor.can_save);
    event(
        &mut d,
        i,
        aev(ae::Kind::Currency(ae::CurrencyEdited {
            text: "usd".into(),
        })),
    );
    assert_eq!(acc(d.view(i)).editor.as_ref().unwrap().currency, "USD");
    event(
        &mut d,
        i,
        aev(ae::Kind::KindPicked(ae::KindPicked {
            kind: "savings".into(),
        })),
    );
    event(&mut d, i, aev(ae::Kind::Save(ae::Save {})));
    assert!(acc(d.view(i)).editor.is_none());
    assert_eq!(
        acc(d.view(i)).status.as_ref().unwrap().sentence,
        "Account saved"
    );
    let after = names(d.view(i));
    assert_eq!(after.len(), before + 1);
    assert!(after.contains(&"Holiday fund".to_owned()));
}

#[test]
fn editing_an_account_renames_it_and_closing_it_marks_it_closed() {
    let mut d = driver();
    let i = push(&mut d, routes::accounts("Money"));
    let (id, _) = accounts(&d).remove(0);
    event(
        &mut d,
        i,
        aev(ae::Kind::Account(ae::AccountTapped {
            account_id: id.clone(),
        })),
    );
    let editor = acc(d.view(i)).editor.clone().unwrap();
    assert_eq!(editor.title, "Edit account");
    assert!(
        editor.currency_label.is_empty(),
        "an account's currency is not editable"
    );
    assert!(!editor.closed_label.is_empty());
    event(
        &mut d,
        i,
        aev(ae::Kind::Name(ae::NameEdited {
            text: "Renamed".into(),
        })),
    );
    event(&mut d, i, aev(ae::Kind::Closed(ae::ClosedToggled {})));
    event(&mut d, i, aev(ae::Kind::Save(ae::Save {})));
    assert!(acc(d.view(i)).editor.is_none());
    let row = acc_data(d.view(i))
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .find(|r| r.account_id == id)
        .unwrap();
    assert_eq!(row.name, "Renamed");
    assert!(row.meta.ends_with("closed"), "{}", row.meta);
}

#[test]
fn removing_a_bank_number_is_offered_only_when_there_is_one_and_asks_first() {
    let mut d = driver();
    let i = push(&mut d, routes::accounts("Money"));
    let (id, _) = accounts(&d).remove(0);
    event(
        &mut d,
        i,
        aev(ae::Kind::Account(ae::AccountTapped { account_id: id })),
    );
    let editor = acc(d.view(i)).editor.clone().unwrap();
    event(&mut d, i, aev(ae::Kind::RemoveNumber(ae::RemoveNumber {})));
    if editor.can_remove_number {
        assert!(!editor.remove_number_label.is_empty());
        assert_eq!(
            acc(d.view(i)).confirm.as_ref().unwrap().title,
            "Remove the bank number?"
        );
    } else {
        assert!(editor.remove_number_label.is_empty());
        assert!(acc(d.view(i)).confirm.is_none());
    }
}

#[test]
fn a_sheet_closed_drops_the_unsaved_editor() {
    let mut d = driver();
    let i = push(&mut d, routes::accounts("Money"));
    event(&mut d, i, aev(ae::Kind::Add(ae::AddTapped {})));
    event(
        &mut d,
        i,
        aev(ae::Kind::Name(ae::NameEdited {
            text: "Nope".into(),
        })),
    );
    event(&mut d, i, aev(ae::Kind::SheetClosed(ae::SheetClosed {})));
    assert!(acc(d.view(i)).editor.is_none());
    assert!(!names(d.view(i)).contains(&"Nope".to_owned()));
}

// --- categories --------------------------------------------------------------

fn cat(v: &wire::ViewState) -> &wire::MoneyCategoriesState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyCategories(s)) => s,
        other => panic!("not categories: {other:?}"),
    }
}

fn cat_data(v: &wire::ViewState) -> &wire::MoneyCategoriesData {
    match &cat(v).content {
        Some(wire::money_categories_state::Content::Data(d)) => d,
        other => panic!("no categories data: {other:?}"),
    }
}

fn cev(kind: ce::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneyCategories(wire::MoneyCategoriesEvent { kind: Some(kind) })
}

fn category_labels(v: &wire::ViewState) -> Vec<String> {
    cat_data(v)
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .map(|r| r.label.clone())
        .collect()
}

fn entry(v: &wire::ViewState, id: &str) -> wire::MoneyCategoryEntry {
    cat_data(v)
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .find(|r| r.category_id == id)
        .unwrap()
        .clone()
}

#[test]
fn adding_a_category_under_a_group_names_it_and_lists_it() {
    let mut d = driver();
    let i = push(&mut d, routes::categories("Money"));
    let group = cat_data(d.view(i)).groups[0].group_id.clone();
    event(&mut d, i, cev(ce::Kind::Add(ce::AddTapped {})));
    assert_eq!(
        cat(d.view(i)).sheet,
        wire::money_categories_state::Sheet::Add as i32
    );
    assert!(!cat_data(d.view(i)).can_save);
    event(
        &mut d,
        i,
        cev(ce::Kind::Name(ce::NameEdited {
            text: "Pet sitting".into(),
        })),
    );
    event(
        &mut d,
        i,
        cev(ce::Kind::Group(ce::GroupPicked { group_id: group })),
    );
    assert!(cat_data(d.view(i)).can_save);
    event(&mut d, i, cev(ce::Kind::Save(ce::Save {})));
    assert_eq!(
        cat(d.view(i)).status.as_ref().unwrap().sentence,
        "Category added"
    );
    assert!(category_labels(d.view(i)).contains(&"Pet sitting".to_owned()));
}

#[test]
fn a_name_over_sixty_characters_cannot_be_saved() {
    let mut d = driver();
    let i = push(&mut d, routes::categories("Money"));
    event(&mut d, i, cev(ce::Kind::Add(ce::AddTapped {})));
    event(
        &mut d,
        i,
        cev(ce::Kind::Name(ce::NameEdited {
            text: "x".repeat(61),
        })),
    );
    let data = cat_data(d.view(i));
    assert!(!data.can_save);
    assert_eq!(data.issue, "Use 60 characters or fewer.");
}

fn first_category(d: &Driver, i: u64) -> (String, String) {
    let row = cat_data(d.view(i))
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .next()
        .unwrap()
        .clone();
    (row.category_id, row.label)
}

#[test]
fn archiving_a_category_marks_it_and_restoring_brings_it_back() {
    let mut d = driver();
    let i = push(&mut d, routes::categories("Money"));
    let (id, label) = first_category(&d, i);
    event(
        &mut d,
        i,
        cev(ce::Kind::Category(ce::CategoryTapped {
            category_id: id.clone(),
        })),
    );
    assert_eq!(cat_data(d.view(i)).row_title, label);
    let keys: Vec<_> = cat_data(d.view(i))
        .row_actions
        .iter()
        .map(|a| a.key.clone())
        .collect();
    assert_eq!(keys, ["merge", "archive"]);
    event(
        &mut d,
        i,
        cev(ce::Kind::RowAction(ce::RowAction {
            key: "archive".into(),
        })),
    );
    let row = entry(d.view(i), &id);
    assert!(row.archived);
    assert_eq!(row.meta, "Archived");
    event(
        &mut d,
        i,
        cev(ce::Kind::Category(ce::CategoryTapped {
            category_id: id.clone(),
        })),
    );
    let keys: Vec<_> = cat_data(d.view(i))
        .row_actions
        .iter()
        .map(|a| a.key.clone())
        .collect();
    assert_eq!(keys, ["merge", "restore"]);
    assert!(
        !cat_data(d.view(i)).row_actions[0].enabled,
        "an archived category cannot be merged"
    );
    event(
        &mut d,
        i,
        cev(ce::Kind::RowAction(ce::RowAction {
            key: "restore".into(),
        })),
    );
    assert!(!entry(d.view(i), &id).archived);
}

#[test]
fn merging_asks_first_and_then_reports_it_done() {
    let mut d = driver();
    let i = push(&mut d, routes::categories("Money"));
    event(&mut d, i, cev(ce::Kind::Add(ce::AddTapped {})));
    event(
        &mut d,
        i,
        cev(ce::Kind::Name(ce::NameEdited {
            text: "Temp one".into(),
        })),
    );
    let group = cat_data(d.view(i)).groups[0].group_id.clone();
    event(
        &mut d,
        i,
        cev(ce::Kind::Group(ce::GroupPicked { group_id: group })),
    );
    event(&mut d, i, cev(ce::Kind::Save(ce::Save {})));
    let from = cat_data(d.view(i))
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .find(|r| r.label == "Temp one")
        .unwrap()
        .category_id
        .clone();
    event(
        &mut d,
        i,
        cev(ce::Kind::Category(ce::CategoryTapped {
            category_id: from.clone(),
        })),
    );
    event(
        &mut d,
        i,
        cev(ce::Kind::RowAction(ce::RowAction {
            key: "merge".into(),
        })),
    );
    let options = cat_data(d.view(i)).merge_options.clone();
    assert!(options.iter().all(|o| o.key != from));
    let into = options[0].clone();
    event(
        &mut d,
        i,
        cev(ce::Kind::MergeInto(ce::MergeInto {
            category_id: into.key.clone(),
        })),
    );
    let confirm = cat(d.view(i)).confirm.clone().expect("a confirmation");
    assert_eq!(confirm.title, "Merge categories?");
    assert_eq!(
        confirm.body,
        format!("Rows filed under Temp one move to {}.", into.label)
    );
    event(
        &mut d,
        i,
        cev(ce::Kind::ConfirmDismissed(ce::ConfirmDismissed {})),
    );
    assert!(cat(d.view(i)).confirm.is_none());
    event(
        &mut d,
        i,
        cev(ce::Kind::MergeInto(ce::MergeInto {
            category_id: into.key,
        })),
    );
    event(
        &mut d,
        i,
        cev(ce::Kind::ConfirmAccepted(ce::ConfirmAccepted {})),
    );
    assert_eq!(
        cat(d.view(i)).status.as_ref().unwrap().sentence,
        "Categories merged"
    );
}

// --- rules -------------------------------------------------------------------

fn rul(v: &wire::ViewState) -> &wire::MoneyRulesState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyRules(s)) => s,
        other => panic!("not rules: {other:?}"),
    }
}

fn rul_data(v: &wire::ViewState) -> &wire::MoneyRulesData {
    match &rul(v).content {
        Some(wire::money_rules_state::Content::Data(d)) => d,
        other => panic!("no rules data: {other:?}"),
    }
}

fn rev(kind: re::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneyRules(wire::MoneyRulesEvent { kind: Some(kind) })
}

/// Add a rule for `words` filed under the first category.
fn add_rule(d: &mut Driver, i: u64, words: &str) {
    event(d, i, rev(re::Kind::Add(re::AddTapped {})));
    event(
        d,
        i,
        rev(re::Kind::Pattern(re::PatternEdited { text: words.into() })),
    );
    let pick = rul_data(d.view(i))
        .category_options
        .iter()
        .find(|o| !o.key.is_empty())
        .unwrap()
        .clone();
    event(
        d,
        i,
        rev(re::Kind::Category(re::CategoryPicked {
            category_id: pick.key,
        })),
    );
    event(d, i, rev(re::Kind::Save(re::Save {})));
}

#[test]
fn a_rule_needs_words_and_a_category_before_it_can_be_saved() {
    let mut d = driver();
    let i = push(&mut d, routes::rules("Money"));
    event(&mut d, i, rev(re::Kind::Add(re::AddTapped {})));
    let editor = rul(d.view(i)).editor.clone().expect("an editor");
    assert_eq!(editor.title, "Add a rule");
    assert!(!editor.can_save);
    assert!(editor.issue.is_empty());
    event(
        &mut d,
        i,
        rev(re::Kind::Pattern(re::PatternEdited {
            text: "COFFEE SHOP".into(),
        })),
    );
    let editor = rul(d.view(i)).editor.clone().unwrap();
    assert_eq!(editor.issue, "Choose a category.");
    assert!(!editor.can_save);
    event(
        &mut d,
        i,
        rev(re::Kind::CategorySheet(re::CategorySheetOpened {})),
    );
    assert_eq!(
        rul(d.view(i)).sheet,
        wire::money_rules_state::Sheet::Category as i32
    );
    let pick = rul_data(d.view(i))
        .category_options
        .iter()
        .find(|o| !o.key.is_empty())
        .unwrap()
        .clone();
    event(
        &mut d,
        i,
        rev(re::Kind::Category(re::CategoryPicked {
            category_id: pick.key,
        })),
    );
    assert_eq!(
        rul(d.view(i)).sheet,
        wire::money_rules_state::Sheet::Editor as i32
    );
    assert!(rul(d.view(i)).editor.as_ref().unwrap().can_save);
    event(&mut d, i, rev(re::Kind::Save(re::Save {})));
    assert!(rul(d.view(i)).editor.is_none());
    assert_eq!(
        rul(d.view(i)).status.as_ref().unwrap().sentence,
        "Rule saved"
    );
    assert!(
        rul_data(d.view(i))
            .rows
            .iter()
            .any(|r| r.title.eq_ignore_ascii_case("COFFEE SHOP"))
    );
    assert!(rul_data(d.view(i)).limit_line.contains(" of "));
}

#[test]
fn a_saved_rule_opens_for_editing_and_deleting_asks_first() {
    let mut d = driver();
    let i = push(&mut d, routes::rules("Money"));
    add_rule(&mut d, i, "GYM");
    let id = rul_data(d.view(i))
        .rows
        .iter()
        .find(|r| r.title.eq_ignore_ascii_case("GYM"))
        .unwrap()
        .rule_id
        .clone();
    event(
        &mut d,
        i,
        rev(re::Kind::Rule(re::RuleTapped { rule_id: id })),
    );
    let editor = rul(d.view(i)).editor.clone().unwrap();
    assert_eq!(editor.title, "Edit rule");
    assert_eq!(editor.mode, wire::money_rule_editor::Mode::Edit as i32);
    assert!(!editor.category_label.is_empty());
    assert_eq!(editor.delete_label, "Delete rule");
    event(&mut d, i, rev(re::Kind::Delete(re::Delete {})));
    assert_eq!(
        rul(d.view(i)).confirm.as_ref().unwrap().title,
        "Delete this rule?"
    );
    event(
        &mut d,
        i,
        rev(re::Kind::ConfirmDismissed(re::ConfirmDismissed {})),
    );
    assert!(rul(d.view(i)).confirm.is_none());
    event(&mut d, i, rev(re::Kind::Delete(re::Delete {})));
    event(
        &mut d,
        i,
        rev(re::Kind::ConfirmAccepted(re::ConfirmAccepted {})),
    );
    assert_eq!(
        rul(d.view(i)).status.as_ref().unwrap().sentence,
        "Rule deleted"
    );
    assert!(
        !rul_data(d.view(i))
            .rows
            .iter()
            .any(|r| r.title.eq_ignore_ascii_case("GYM"))
    );
}

#[test]
fn applying_the_rules_to_earlier_rows_asks_first() {
    let mut d = driver();
    let i = push(&mut d, routes::rules("Money"));
    add_rule(&mut d, i, "ANYTHING");
    assert_eq!(rul_data(d.view(i)).apply_label, "Apply to earlier rows");
    event(&mut d, i, rev(re::Kind::Apply(re::Apply {})));
    let confirm = rul(d.view(i)).confirm.clone().unwrap();
    assert_eq!(confirm.title, "Apply to earlier rows?");
    assert!(!confirm.destructive);
    event(
        &mut d,
        i,
        rev(re::Kind::ConfirmAccepted(re::ConfirmAccepted {})),
    );
    assert_eq!(
        rul(d.view(i)).status.as_ref().unwrap().sentence,
        "Rules applied"
    );
}

#[test]
fn a_rule_limited_to_an_account_checks_its_limits_in_that_accounts_units() {
    let mut d = driver();
    let i = push(&mut d, routes::rules("Money"));
    event(&mut d, i, rev(re::Kind::Add(re::AddTapped {})));
    let (account, name) = accounts(&d).remove(0);
    event(
        &mut d,
        i,
        rev(re::Kind::AccountSheet(re::AccountSheetOpened {})),
    );
    event(
        &mut d,
        i,
        rev(re::Kind::Account(re::AccountPicked {
            account_id: account,
        })),
    );
    let editor = rul(d.view(i)).editor.clone().unwrap();
    assert_eq!(editor.account_label, name);
    assert!(editor.limits_enabled);
    assert!(editor.amount_min_label.starts_with("Smallest amount"));
    event(
        &mut d,
        i,
        rev(re::Kind::Pattern(re::PatternEdited {
            text: "LIMITS".into(),
        })),
    );
    let pick = rul_data(d.view(i))
        .category_options
        .iter()
        .find(|o| !o.key.is_empty())
        .unwrap()
        .clone();
    event(
        &mut d,
        i,
        rev(re::Kind::Category(re::CategoryPicked {
            category_id: pick.key,
        })),
    );
    event(
        &mut d,
        i,
        rev(re::Kind::AmountMin(re::AmountMinEdited {
            text: "50".into(),
        })),
    );
    event(
        &mut d,
        i,
        rev(re::Kind::AmountMax(re::AmountMaxEdited {
            text: "10".into(),
        })),
    );
    let editor = rul(d.view(i)).editor.clone().unwrap();
    assert_eq!(
        editor.issue,
        "The smallest amount is more than the largest."
    );
    assert!(!editor.can_save);
    event(
        &mut d,
        i,
        rev(re::Kind::AmountMax(re::AmountMaxEdited {
            text: "abc".into(),
        })),
    );
    assert_eq!(
        rul(d.view(i)).editor.as_ref().unwrap().issue,
        "Type an amount, like 220.00."
    );
}
