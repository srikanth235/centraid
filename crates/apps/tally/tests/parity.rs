//! PARITY WITH v0, read off `contracts/apps/tally/`.
//!
//! Two halves, because the app has two:
//!
//! 1. **The balance engine**, against `balances.json`. Pure in, pure out — the
//!    fold that decides who owes whom, compared answer for answer with what
//!    v0's own engine produced for the same inputs.
//! 2. **`loadTally`**, against `rows.json`. The fixture's rows are inserted into
//!    a database created from `contracts/schema/vault-ddl.sql` — the committed
//!    schema, so there is no second copy of it here — and the ported statements
//!    are read back through the kit's test door. What is asserted is the FOLD:
//!    the party set (including the member who left), the live-versus-trashed
//!    split, the per-group membership, and that every balance reconciles.
//!
//! **What is not asserted yet, and why.** `queries.json` carries all eight
//! query outputs at 29 fixed inputs, and this lane does not compare them. The
//! outputs carry presentation the port has no source for yet — a party's
//! colour from `partyHueValue`, its initials from `identityInitials`, the
//! ledger row's tone from `figureTone` — all of which live in
//! `packages/design` and move to `design/` in wave 3/4 with the token emitter
//! (D-1020-D3-9). Comparing the arithmetic without them would mean editing the
//! fixture to drop fields, which is the one thing a generated fixture must not
//! allow. The fixture is committed and is the target; the receipt records it as
//! the next wave's first job.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_tally::balance::{
    BalanceData, BalanceExpense, BalanceSettlement, attribute_expense, group_net, group_pair_nets,
    minimal_transfers, open_debt_count, simplification,
};
use centraid_apps_tally::queries::{LEDGER_ROWS, load_tally};
use rusqlite::Connection;
use serde_json::{Value, json};

/// The repository root, from this crate's manifest directory.
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture(name: &str) -> Value {
    let path = root().join("contracts/apps/tally").join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

// ---------------------------------------------------------------------------
// 1. The balance engine.
// ---------------------------------------------------------------------------

fn minor_map(value: &Value) -> BTreeMap<String, i64> {
    value
        .as_object()
        .expect("a minor-unit map is an object")
        .iter()
        .map(|(party, amount)| {
            (
                party.clone(),
                amount.as_i64().expect("minor units are integers"),
            )
        })
        .collect()
}

fn balance_data(value: &Value) -> BalanceData {
    BalanceData {
        members_by_group: value["members_by_group"]
            .as_array()
            .expect("members_by_group is a list of entries")
            .iter()
            .map(|entry| {
                (
                    entry[0].as_str().expect("a group id").to_owned(),
                    entry[1]
                        .as_array()
                        .expect("a roster")
                        .iter()
                        .map(|party| party.as_str().expect("a party id").to_owned())
                        .collect(),
                )
            })
            .collect(),
        expenses: value["expenses"]
            .as_array()
            .expect("expenses is a list")
            .iter()
            .map(|expense| BalanceExpense {
                group_id: expense["group_id"].as_str().map(str::to_owned),
                paid_by: expense["paid_by"].as_str().expect("paid_by").to_owned(),
                amount_minor: expense["amount_minor"].as_i64().expect("an amount"),
                splits: minor_map(&expense["splits"]),
                payers: minor_map(&expense["payers"]),
            })
            .collect(),
        settlements: value["settlements"]
            .as_array()
            .expect("settlements is a list")
            .iter()
            .map(|settlement| BalanceSettlement {
                group_id: settlement["group_id"].as_str().map(str::to_owned),
                from_party: settlement["from_party"].as_str().expect("from").to_owned(),
                to_party: settlement["to_party"].as_str().expect("to").to_owned(),
                amount_minor: settlement["amount_minor"].as_i64().expect("an amount"),
            })
            .collect(),
    }
}

fn money_json(amount: &centraid_apps_kit::money::Money) -> Value {
    json!({ "amount_minor": amount.amount_minor, "currency": amount.currency.code() })
}

fn transfers_json(transfers: &[centraid_apps_tally::balance::Transfer]) -> Value {
    Value::Array(
        transfers
            .iter()
            .map(|transfer| {
                json!({
                    "from": transfer.from,
                    "to": transfer.to,
                    "amount": money_json(&transfer.amount),
                })
            })
            .collect(),
    )
}

fn simplification_json(answer: &centraid_apps_tally::balance::Simplification) -> Value {
    json!({
        "opted_in": answer.opted_in,
        "transfers": transfers_json(&answer.transfers),
        "debts_before": answer.debts_before,
        "payments_after": answer.payments_after,
    })
}

#[test]
fn the_balance_engine_answers_what_v0s_answers() {
    let cases = fixture("balances.json");
    let cases = cases.as_array().expect("balances.json is a list of cases");
    assert!(
        cases.len() >= 6,
        "a parity run over no cases is not a parity run"
    );
    let mut compared = 0usize;
    for case in cases {
        let name = case["case"].as_str().expect("a case name");
        let claim = case["claim"].as_str().expect("a claim");
        let group_id = case["group_id"].as_str().expect("a group id");
        let currency = case["currency"].as_str().expect("a currency");
        let data = balance_data(&case["data"]);
        let expected = &case["expected"];

        let attributions = Value::Array(
            data.expenses
                .iter()
                .filter(|expense| expense.group_id.as_deref() == Some(group_id))
                .map(|expense| {
                    Value::Array(
                        attribute_expense(expense)
                            .iter()
                            .map(|attribution| {
                                json!({
                                    "from": attribution.from,
                                    "to": attribution.to,
                                    "amount_minor": attribution.amount_minor,
                                })
                            })
                            .collect(),
                    )
                })
                .collect(),
        );
        assert_eq!(
            attributions, expected["attributions"],
            "{name}: {claim} (attributions)"
        );

        let net = group_net(&data, group_id);
        let net_json = Value::Array(
            net.iter()
                .map(|(party, amount)| json!([party, amount]))
                .collect(),
        );
        assert_eq!(net_json, expected["net"], "{name}: {claim} (net)");

        let pair = group_pair_nets(&data, group_id);
        let pair_json = Value::Array(
            pair.iter()
                .map(|(party, row)| {
                    json!([
                        party,
                        Value::Array(
                            row.iter()
                                .map(|(other, amount)| json!([other, amount]))
                                .collect()
                        )
                    ])
                })
                .collect(),
        );
        assert_eq!(
            pair_json, expected["pairwise"],
            "{name}: {claim} (pairwise)"
        );
        assert_eq!(
            json!(open_debt_count(&pair)),
            expected["open_debts"],
            "{name}: {claim} (open debts)"
        );
        assert_eq!(
            transfers_json(&minimal_transfers(&net, currency)),
            expected["minimal_transfers"],
            "{name}: {claim} (minimal transfers)"
        );
        assert_eq!(
            simplification_json(&simplification(&data, group_id, false, currency)),
            expected["simplification_off"],
            "{name}: {claim} (simplification off)"
        );
        assert_eq!(
            simplification_json(&simplification(&data, group_id, true, currency)),
            expected["simplification_on"],
            "{name}: {claim} (simplification on)"
        );
        compared += 1;
    }
    assert_eq!(compared, cases.len());
}

// ---------------------------------------------------------------------------
// 2. `loadTally` over the fixture's rows.
// ---------------------------------------------------------------------------

/// The fixture vault: the committed DDL, plus the fixture's rows.
///
/// The builder is `centraid_apps_kit::fixtures::open_contract_vault`, and it
/// lives there rather than here because `sql-confinement` scans this file too:
/// an app's test must not hold a statement any more than its handlers may.
fn fixture_vault() -> Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let rows = fs::read_to_string(root().join("contracts/apps/tally/rows.json"))
        .expect("the fixture rows are readable");
    open_contract_vault(&ddl, &rows).expect("the fixture vault is built")
}

#[test]
fn load_tally_reads_the_fixture_ledger_as_v0_wrote_it() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let data = load_tally(&door).expect("loadTally reads the fixture");

    // The owner and the base currency come off `core_vault`.
    assert!(data.me.is_some(), "the vault row names its owner");
    assert_eq!(data.currency, "GBP");

    // Three friends, three groups, three currencies — one ledger per money.
    assert_eq!(data.friends.len(), 3);
    assert_eq!(data.groups.len(), 3);
    let mut currencies: Vec<&str> = data
        .groups
        .iter()
        .map(|group| group.currency.as_str())
        .collect();
    currencies.sort_unstable();
    assert_eq!(currencies, vec!["EUR", "GBP", "JPY"]);

    // A group's NAME comes off its circle, never off the group row.
    for group in &data.groups {
        assert!(
            !group.name.is_empty(),
            "{} has no name; a group is a circle decorated by a group row",
            group.group_id
        );
    }

    // The expenses window excludes the trashed one, and the trash shelf is the
    // other side of the same predicate.
    let (trash, recurring, exceptions) = centraid_apps_tally::queries::load_dashboard_extras(&door)
        .expect("the dashboard's three extra pages read");
    assert_eq!(data.expenses.len(), 6, "six live expenses");
    assert_eq!(trash.len(), 1, "one trashed expense");
    assert_eq!(recurring.len(), 1, "one standing order");
    assert_eq!(exceptions.len(), 1, "one overridden occurrence");
    assert!(
        data.expenses
            .iter()
            .all(|expense| expense.deleted_at.is_none()),
        "the live window must carry no trashed row"
    );

    // THE DEPARTED MEMBER. Bo left the flat, so Bo is not in the current
    // roster and IS still nameable, because the ledger still refers to them.
    let flat = data
        .groups
        .iter()
        .find(|group| group.name == "Sitwell Road")
        .expect("the flat is in the fixture");
    let roster = &data.members_by_group[&flat.group_id];
    let departed: Vec<&String> = data
        .people
        .keys()
        .filter(|party| !roster.contains(party) && data.me.as_ref() != Some(party))
        .collect();
    assert!(
        !departed.is_empty(),
        "a member who left must stay nameable: membership is current state, the ledger is history"
    );
    for expense in &data.expenses {
        for sharer in data
            .splits
            .get(&expense.expense_id)
            .into_iter()
            .flat_map(BTreeMap::keys)
        {
            assert!(
                data.people.contains_key(sharer),
                "{sharer} shares {} and has no name",
                expense.expense_id
            );
        }
    }

    // Every live expense carries its payer set, and it sums to the amount.
    for expense in &data.expenses {
        let payers = data
            .payers
            .get(&expense.expense_id)
            .expect("payer rows are ground facts (#883, ruling O-payers)");
        assert_eq!(
            payers.values().sum::<i64>(),
            expense.amount_minor,
            "{} payer set does not sum to its amount",
            expense.expense_id
        );
        let splits = data
            .splits
            .get(&expense.expense_id)
            .expect("an expense stores its resolved splits");
        assert_eq!(
            splits.values().sum::<i64>(),
            expense.amount_minor,
            "{} splits do not sum to its amount",
            expense.expense_id
        );
    }

    // And every group's balance reconciles: each pair row sums to that
    // member's net with the sign flipped.
    let balances = data.balance_data();
    for group in &data.groups {
        let net = group_net(&balances, &group.group_id);
        let pair = group_pair_nets(&balances, &group.group_id);
        for (party, row) in &pair {
            assert_eq!(
                row.values().sum::<i64>(),
                -net.get(party).copied().unwrap_or(0),
                "{}: the pair row of {party} does not reconcile",
                group.name
            );
        }
    }

    // The group-less 1:1 expense belongs to no group and still has a currency.
    let loose: Vec<&centraid_apps_tally::queries::ExpenseRow> = data
        .expenses
        .iter()
        .filter(|expense| expense.group_id.is_none())
        .collect();
    assert_eq!(loose.len(), 1, "one group-less 1:1 expense (GAPS #4)");
    assert_eq!(data.expense_currency(loose[0]), "GBP");
}

/// A DEMONSTRATED RED for the fan-out ceiling: a walk past its bound errors,
/// with the member-visible outcome v0's throw has, rather than answering short.
#[test]
fn a_fan_out_past_its_ceiling_errors_rather_than_answering_short() {
    use centraid_apps_kit::reads::{FanOutBound, read_pages};
    use centraid_apps_tally::queries::{is_fan_out_ceiling, splits_statement};

    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    // The fixture has sixteen split rows; a bound of two pages of one row
    // cannot reach the end of them.
    let outcome = read_pages(&door, &splits_statement(), FanOutBound::new(1, 2));
    let error = outcome.expect_err("a walk that cannot finish must say so");
    assert!(is_fan_out_ceiling(&error), "{error}");
    assert!(
        error.to_string().contains("is not bounded"),
        "the sentence must name what went wrong: {error}"
    );
    // And the honest bound reads the whole set.
    let whole = read_pages(&door, &splits_statement(), FanOutBound::new(LEDGER_ROWS, 8))
        .expect("a bound that fits reads every row");
    assert_eq!(whole.len(), 16);
}
