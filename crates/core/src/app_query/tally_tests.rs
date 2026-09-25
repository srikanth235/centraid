//! Tally's arm, through `Handle::call` — the door a shell uses — over ledgers
//! written by the real `tally.*` commands.

use super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};
use serde_json::json;
use wire::app_query_request::Query as Q;

/// 02:00Z on 1 July is still 30 June in New York: a month or a day read in
/// UTC answers differently from one read in the device's zone.
const NOW: &str = "2099-07-01T02:00:00.000Z";
const TZ: &str = "America/New_York";

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Scratch {
    fn founded() -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
        let handle = Core::open(CoreConfig::new(dir.join("vault.db")).with_clock(
            std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                centraid_vault::clock::FixedClock::at(now),
            ))),
        ))
        .expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Tally", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn ask(&self, query: Q) -> Result<Answer> {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(query),
                })),
            })?
            .kind
        {
            Some(wire::response::Kind::AppQuery(answer)) => {
                Ok(answer.answer.expect("an app query is answered"))
            }
            other => panic!("an app query answered as {other:?}"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.writes.set(self.writes.get() + 1);
        let response = self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: name.to_owned(),
                    input: serde_json::to_vec(&input).expect("json"),
                    invoke_key: format!("tally-query-test-{}", self.writes.get()),
                    ..wire::Command::default()
                })),
            })
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        let Some(wire::response::Kind::Command(outcome)) = response.kind else {
            panic!("a command answered with something else");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{name}: {}",
            outcome.reason
        );
        serde_json::from_slice(&outcome.output).expect("the output is JSON")
    }

    fn friend(&self, name: &str) -> String {
        self.run("tally.add_friend", json!({ "name": name }))["party_id"]
            .as_str()
            .expect("a party id")
            .to_owned()
    }

    fn group(&self, name: &str, currency: &str, members: &[&str]) -> String {
        self.run(
            "tally.create_group",
            json!({ "name": name, "icon": "🏠", "currency": currency, "member_ids": members }),
        )["group_id"]
            .as_str()
            .expect("a group id")
            .to_owned()
    }

    fn expense(&self, input: serde_json::Value) -> String {
        self.run("tally.add_expense", input)["expense_id"]
            .as_str()
            .expect("an expense id")
            .to_owned()
    }

    fn dashboard(&self) -> wire::TallyDashboard {
        match self
            .ask(Q::TallyDashboard(wire::TallyDashboardRequest {
                tz: TZ.to_owned(),
            }))
            .expect("the dashboard answers")
        {
            Answer::TallyDashboard(dashboard) => dashboard,
            other => panic!("the dashboard answered as {other:?}"),
        }
    }

    fn me(&self) -> String {
        self.dashboard().me.expect("founding names the owner")
    }

    fn group_ledger(&self, group_id: &str) -> wire::TallyGroupLedger {
        match self
            .ask(Q::TallyGroup(wire::TallyGroupRequest {
                group_id: group_id.to_owned(),
            }))
            .expect("the group answers")
        {
            Answer::TallyGroup(group) => group,
            other => panic!("the group answered as {other:?}"),
        }
    }

    fn settle_up(&self, group_id: &str) -> wire::TallySettleUp {
        match self
            .ask(Q::TallySettleUp(wire::TallySettleUpRequest {
                group_id: group_id.to_owned(),
            }))
            .expect("settle-up answers")
        {
            Answer::TallySettleUp(answer) => answer,
            other => panic!("settle-up answered as {other:?}"),
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn splits(parts: &[(&str, i64)]) -> serde_json::Value {
    parts
        .iter()
        .map(|(party, share)| json!({ "party_id": party, "share_minor": share }))
        .collect()
}

fn minor_of(amounts: &[wire::TallyMoney], currency: &str) -> Option<i64> {
    amounts
        .iter()
        .find(|amount| amount.currency == currency)
        .map(|amount| amount.minor)
}

fn net_of(group: &wire::TallyGroupLedger, party_id: &str) -> i64 {
    group
        .members
        .iter()
        .find(|member| {
            member
                .person
                .as_ref()
                .is_some_and(|p| p.party_id == party_id)
        })
        .and_then(|member| member.net.as_ref())
        .map_or(0, |net| net.minor)
}

/// A ledger in one group entered with all six split methods.
struct SixWays {
    scratch: Scratch,
    me: String,
    ana: String,
    bo: String,
    house: String,
}

fn six_ways() -> SixWays {
    let scratch = Scratch::founded();
    let me = scratch.me();
    let ana = scratch.friend("Ana");
    let bo = scratch.friend("Bo");
    let house = scratch.group("House", "USD", &[&ana, &bo]);
    let add = |description: &str,
               amount: i64,
               paid_by: &str,
               method: &str,
               shares: &[(&str, i64)],
               extra: serde_json::Value| {
        let mut input = json!({
            "group_id": house,
            "description": description,
            "amount_minor": amount,
            "paid_by": paid_by,
            "category": "groceries",
            "spent_on": "2099-06-20",
            "split_method": method,
            "splits": splits(shares),
        });
        if let serde_json::Value::Object(more) = extra {
            for (key, value) in more {
                input[key] = value;
            }
        }
        scratch.expense(input)
    };
    // Equally: the odd penny to the payer.
    add(
        "Groceries",
        10_000,
        &me,
        "equally",
        &[(&me, 3_334), (&ana, 3_333), (&bo, 3_333)],
        json!({}),
    );
    add(
        "Taxi",
        6_000,
        &ana,
        "exact",
        &[(&me, 1_000), (&ana, 2_000), (&bo, 3_000)],
        json!({ "split_params": { "unit": "money",
            "entries": { &me: 1_000, &ana: 2_000, &bo: 3_000 } } }),
    );
    add(
        "Rent",
        20_000,
        &bo,
        "percentages",
        &[(&me, 5_000), (&ana, 5_000), (&bo, 10_000)],
        json!({ "split_params": { "unit": "percent",
            "entries": { &me: 25, &ana: 25, &bo: 50 } } }),
    );
    add(
        "Wine",
        9_000,
        &me,
        "shares",
        &[(&me, 3_000), (&ana, 6_000)],
        json!({ "split_params": { "unit": "shares", "entries": { &me: 1, &ana: 2 } } }),
    );
    add(
        "Dinner",
        7_000,
        &ana,
        "adjusted",
        &[(&me, 2_500), (&ana, 2_000), (&bo, 2_500)],
        json!({ "split_params": { "unit": "adjust", "entries": { &me: 500, &bo: 500 } } }),
    );
    add(
        "Hardware",
        3_000,
        &me,
        "by_line",
        &[(&ana, 2_000), (&me, 500), (&bo, 500)],
        json!({ "line_items": [
            { "kind": "item", "description": "Paint", "amount_minor": 2_000,
              "allocations": [{ "party_id": &ana, "share_minor": 2_000 }] },
            { "kind": "item", "description": "Brushes", "amount_minor": 1_000,
              "allocations": [{ "party_id": &me, "share_minor": 500 },
                              { "party_id": &bo, "share_minor": 500 }] },
        ] }),
    );
    SixWays {
        scratch,
        me,
        ana,
        bo,
        house,
    }
}

/// AN EMPTY VAULT is an answer, not a refusal: no friends, no groups, no
/// activity, a hero of nothing, and today and yesterday read in New York.
#[test]
fn an_empty_vault_answers_an_empty_dashboard() {
    let scratch = Scratch::founded();
    let dashboard = scratch.dashboard();
    assert!(dashboard.friends.is_empty());
    assert!(dashboard.groups.is_empty() && dashboard.archived_groups.is_empty());
    assert!(dashboard.activity.is_empty());
    assert_eq!(dashboard.expense_count, 0);
    assert_eq!(dashboard.base_currency, "USD");
    assert!(
        dashboard
            .owed
            .expect("a hero")
            .components
            .iter()
            .all(|m| m.minor == 0)
    );
    assert_eq!(dashboard.today, "2099-06-30", "New York's day, not UTC's");
    assert_eq!(dashboard.yesterday, "2099-06-29");

    let settle = scratch.settle_up("");
    assert!(settle.suggestions.is_empty());
    let Answer::TallyTrash(trash) = scratch
        .ask(Q::TallyTrash(wire::TallyTrashRequest { tz: TZ.to_owned() }))
        .expect("trash answers")
    else {
        panic!("trash answered as something else");
    };
    assert!(trash.rows.is_empty());
    // A group, a friend or an expense nobody has is absent, not an error.
    assert!(scratch.group_ledger("no-such-group").group.is_none());
    let Answer::TallyExpense(expense) = scratch
        .ask(Q::TallyExpense(wire::TallyExpenseRequest {
            expense_id: "no-such-expense".to_owned(),
            tz: TZ.to_owned(),
        }))
        .expect("an absent expense answers")
    else {
        panic!("expense answered as something else");
    };
    assert!(expense.expense.is_none());
}

/// THE SIX SPLIT METHODS, folded by the one engine: each member's group net,
/// each friend's position with the owner, and the hero — every figure
/// hand-computed from the shares above.
#[test]
fn balances_fold_all_six_split_methods() {
    let SixWays {
        scratch,
        me,
        ana,
        bo,
        house,
    } = six_ways();

    let group = scratch.group_ledger(&house);
    assert_eq!(net_of(&group, &me), 6_666);
    assert_eq!(net_of(&group, &ana), -7_333);
    assert_eq!(net_of(&group, &bo), 667);
    assert_eq!(group.ledger.len(), 6);
    let methods: std::collections::BTreeSet<&str> = group
        .ledger
        .iter()
        .map(|row| row.split_method.as_str())
        .collect();
    assert_eq!(
        methods,
        [
            "adjusted",
            "by_line",
            "equally",
            "exact",
            "percentages",
            "shares"
        ]
        .into_iter()
        .collect()
    );
    for row in &group.ledger {
        let amount = row.amount.as_ref().expect("an amount");
        let shared: i64 = row
            .splits
            .iter()
            .map(|split| split.amount.as_ref().expect("a share").minor)
            .sum();
        assert_eq!(
            shared, amount.minor,
            "{}'s shares sum to it",
            row.description
        );
        assert_eq!(amount.exponent, 2);
    }
    let percent = group
        .ledger
        .iter()
        .find(|row| row.split_method == "percentages")
        .and_then(|row| row.split_params.as_ref())
        .expect("the percentages are kept");
    assert_eq!(percent.unit, "percent");
    assert_eq!(percent.entries.len(), 3);
    let lines = &group
        .ledger
        .iter()
        .find(|row| row.split_method == "by_line")
        .expect("the by-line expense")
        .lines;
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].description, "Paint");
    // The owner's stance on the wine they paid for: lent, the others' part.
    let wine = group
        .ledger
        .iter()
        .find(|row| row.description == "Wine")
        .expect("the wine");
    assert_eq!(wine.your_role, wire::TallyRole::Lent as i32);
    assert_eq!(wine.your_amount.as_ref().map(|m| m.minor), Some(6_000));

    let dashboard = scratch.dashboard();
    let position = |party: &str| {
        dashboard
            .friends
            .iter()
            .find(|friend| friend.person.as_ref().is_some_and(|p| p.party_id == party))
            .map(|friend| minor_of(&friend.balances, "USD"))
            .expect("a friend")
    };
    assert_eq!(position(&ana), Some(7_833), "Ana owes the owner");
    assert_eq!(position(&bo), Some(-1_167), "the owner owes Bo");
    let owed = dashboard.owed.expect("owed");
    let owe = dashboard.owe.expect("owe");
    assert!(owed.valued && owe.valued, "one currency is one figure");
    assert_eq!(owed.total.map(|m| m.minor), Some(7_833));
    assert_eq!(owe.total.map(|m| m.minor), Some(1_167));
    assert_eq!(
        dashboard.groups[0].your_net.as_ref().map(|m| m.minor),
        Some(6_666),
        "the group card is the owner's group net"
    );
    assert_eq!(dashboard.activity.len(), 6);
}

/// SETTLE-UP: each open pairwise debt until the group opts in, then the
/// minimal set; and once the payments are recorded, nothing is left to settle.
#[test]
fn settle_up_suggests_the_debts_then_the_minimal_payments() {
    let SixWays {
        scratch,
        me,
        ana,
        bo,
        house,
    } = six_ways();
    let triple = |answer: &wire::TallySettleUp| {
        let mut rows: Vec<(String, String, i64)> = answer
            .suggestions
            .iter()
            .map(|s| {
                (
                    s.from.as_ref().expect("from").party_id.clone(),
                    s.to.as_ref().expect("to").party_id.clone(),
                    s.amount.as_ref().expect("an amount").minor,
                )
            })
            .collect();
        rows.sort();
        rows
    };
    let mut direct = vec![
        (ana.clone(), me.clone(), 7_833),
        (me.clone(), bo.clone(), 1_167),
        (bo.clone(), ana.clone(), 500),
    ];
    direct.sort();
    assert_eq!(triple(&scratch.settle_up(&house)), direct);
    let group = scratch.group_ledger(&house);
    let simplification = group.simplification.expect("stated");
    assert!(!simplification.opted_in);
    assert_eq!(simplification.debts_before, 3);

    scratch.run(
        "tally.set_group_simplification",
        json!({ "group_id": house, "simplify": true }),
    );
    let mut minimal = vec![
        (ana.clone(), me.clone(), 6_666),
        (ana.clone(), bo.clone(), 667),
    ];
    minimal.sort();
    assert_eq!(triple(&scratch.settle_up(&house)), minimal);
    let simplification = scratch.group_ledger(&house).simplification.expect("stated");
    assert_eq!(
        (simplification.debts_before, simplification.payments_after),
        (3, 2)
    );

    for (from, to, amount) in &minimal {
        scratch.run(
            "tally.settle_up",
            json!({ "from_party": from, "to_party": to, "amount_minor": amount,
                    "currency": "USD", "group_id": house, "paid_on": "2099-06-25" }),
        );
    }
    assert!(scratch.settle_up(&house).suggestions.is_empty());
    let group = scratch.group_ledger(&house);
    assert!(
        group
            .members
            .iter()
            .all(|m| m.net.as_ref().is_some_and(|n| n.minor == 0))
    );
    assert_eq!(group.settlements.len(), 2);
    // THE GROUP IS LEVEL. A friend's pairwise position with the owner is not:
    // simplification rewired who pays whom, so Ana paid the owner 66.66
    // against a pairwise 78.33, and the owner still owes Bo 11.67 pairwise —
    // the engine's own semantics, stated rather than hidden here.
    let dashboard = scratch.dashboard();
    assert_eq!(
        dashboard.groups[0].your_net.as_ref().map(|m| m.minor),
        Some(0)
    );
}

/// EVERY FIGURE CARRIES ITS OWN EXPONENT, and two monies are never one sum:
/// JPY is 0 digits, BHD 3, GBP 2, and the hero over them is unvalued, stating
/// its components.
#[test]
fn every_money_carries_its_currencys_exponent() {
    let scratch = Scratch::founded();
    let me = scratch.me();
    let ana = scratch.friend("Ana");
    let bo = scratch.friend("Bo");
    let tokyo = scratch.group("Tokyo", "JPY", &[&ana]);
    let manama = scratch.group("Manama", "BHD", &[&bo]);
    let london = scratch.group("London", "GBP", &[&ana]);
    for (group, amount, paid_by, shares) in [
        (
            &tokyo,
            4_200,
            &me,
            vec![(me.as_str(), 2_100), (ana.as_str(), 2_100)],
        ),
        (
            &manama,
            10_500,
            &bo,
            vec![(me.as_str(), 5_250), (bo.as_str(), 5_250)],
        ),
        (
            &london,
            3_000,
            &me,
            vec![(me.as_str(), 1_500), (ana.as_str(), 1_500)],
        ),
    ] {
        scratch.expense(json!({
            "group_id": group, "description": "Out", "amount_minor": amount,
            "paid_by": paid_by, "category": "food", "spent_on": "2099-06-20",
            "splits": splits(&shares),
        }));
    }
    let dashboard = scratch.dashboard();
    let balances = |party: &str| {
        dashboard
            .friends
            .iter()
            .find(|friend| friend.person.as_ref().is_some_and(|p| p.party_id == party))
            .map(|friend| friend.balances.clone())
            .expect("a friend")
    };
    let ana_owes = balances(&ana);
    assert_eq!(ana_owes.len(), 2, "JPY and GBP, never one sum");
    let jpy = ana_owes.iter().find(|m| m.currency == "JPY").expect("JPY");
    assert_eq!((jpy.minor, jpy.exponent), (2_100, 0));
    let gbp = ana_owes.iter().find(|m| m.currency == "GBP").expect("GBP");
    assert_eq!((gbp.minor, gbp.exponent), (1_500, 2));
    let bhd = balances(&bo);
    assert_eq!(bhd.len(), 1);
    assert_eq!(
        (bhd[0].minor, bhd[0].currency.as_str(), bhd[0].exponent),
        (-5_250, "BHD", 3)
    );

    let owed = dashboard.owed.expect("owed");
    assert!(
        !owed.valued,
        "no rate plane, so two monies are not one figure"
    );
    assert!(owed.total.is_none());
    assert_eq!(owed.components.len(), 2);
    let cards: Vec<(String, u32)> = dashboard
        .groups
        .iter()
        .map(|card| {
            let net = card.your_net.as_ref().expect("a net");
            (net.currency.clone(), net.exponent)
        })
        .collect();
    assert!(cards.contains(&("JPY".to_owned(), 0)));
    assert!(cards.contains(&("BHD".to_owned(), 3)));

    // SPENDING IS PER CURRENCY, and the month is New York's (June), not UTC's.
    let Answer::TallySpending(spending) = scratch
        .ask(Q::TallySpending(wire::TallySpendingRequest {
            tz: TZ.to_owned(),
            month: String::new(),
        }))
        .expect("spending answers")
    else {
        panic!("spending answered as something else");
    };
    assert_eq!(spending.month, "2099-06");
    assert_eq!(minor_of(&spending.month_total, "JPY"), Some(4_200));
    assert_eq!(minor_of(&spending.month_total, "BHD"), Some(10_500));
    assert_eq!(minor_of(&spending.paid, "JPY"), Some(4_200));
    assert_eq!(minor_of(&spending.paid, "BHD"), None, "Bo paid that one");
    assert_eq!(minor_of(&spending.share, "BHD"), Some(5_250));
    assert_eq!(minor_of(&spending.difference, "BHD"), Some(-5_250));
    let refused = scratch
        .ask(Q::TallySpending(wire::TallySpendingRequest {
            tz: TZ.to_owned(),
            month: "June".to_owned(),
        }))
        .expect_err("a month is YYYY-MM");
    assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
}

/// A TRASHED EXPENSE LEAVES EVERY BALANCE AND LIST and is on the trash shelf,
/// with its purge date read in the device's zone; its own screen still opens,
/// with the trash revision undoable.
#[test]
fn a_trashed_expense_is_excluded_everywhere_but_the_trash() {
    let scratch = Scratch::founded();
    let me = scratch.me();
    let ana = scratch.friend("Ana");
    let kept = scratch.expense(json!({
        "description": "Cinema", "amount_minor": 2_500, "paid_by": me,
        "category": "food", "spent_on": "2099-06-20",
        "splits": splits(&[(&me, 1_250), (&ana, 1_250)]),
    }));
    let trashed = scratch.expense(json!({
        "description": "Cancelled order", "amount_minor": 1_500, "paid_by": me,
        "category": "food", "spent_on": "2099-06-21",
        "splits": splits(&[(&me, 750), (&ana, 750)]),
    }));
    // No memo is set here, so the live expense below answers none.
    scratch.run("tally.delete_expense", json!({ "expense_id": trashed }));

    let dashboard = scratch.dashboard();
    let ana_position = dashboard
        .friends
        .iter()
        .find(|friend| friend.person.as_ref().is_some_and(|p| p.party_id == ana))
        .map(|friend| minor_of(&friend.balances, "USD"))
        .expect("Ana");
    assert_eq!(ana_position, Some(1_250), "the trashed share is not owed");
    let ids: Vec<&str> = dashboard
        .activity
        .iter()
        .filter_map(|row| match &row.row {
            Some(wire::tally_activity_row::Row::Expense(expense)) => {
                Some(expense.expense_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(ids, [kept.as_str()]);
    let Answer::TallySearch(found) = scratch
        .ask(Q::TallySearch(wire::TallySearchRequest {
            term: "order".to_owned(),
            limit: 10,
        }))
        .expect("search answers")
    else {
        panic!("search answered as something else");
    };
    assert!(found.results.is_empty(), "search is over live expenses");
    let refused = scratch
        .ask(Q::TallySearch(wire::TallySearchRequest {
            term: "order".to_owned(),
            limit: 0,
        }))
        .expect_err("a zero limit is refused");
    assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);

    let Answer::TallyTrash(trash) = scratch
        .ask(Q::TallyTrash(wire::TallyTrashRequest { tz: TZ.to_owned() }))
        .expect("trash answers")
    else {
        panic!("trash answered as something else");
    };
    assert_eq!(trash.rows.len(), 1);
    let row = &trash.rows[0];
    assert_eq!(row.expense_id, trashed);
    assert_eq!(row.deleted_on_local, "2099-06-30", "New York's day");
    assert_eq!(row.purge_on_local.as_deref(), Some("2099-07-30"));
    assert_eq!(row.amount.as_ref().map(|m| m.exponent), Some(2));

    let Answer::TallyExpense(detail) = scratch
        .ask(Q::TallyExpense(wire::TallyExpenseRequest {
            expense_id: trashed.clone(),
            tz: TZ.to_owned(),
        }))
        .expect("a trashed expense opens")
    else {
        panic!("expense answered as something else");
    };
    let expense = detail.expense.expect("the trashed expense");
    assert_eq!(expense.description, "Cancelled order");
    assert!(
        expense
            .splits
            .iter()
            .all(|split| split.person.as_ref().is_some_and(|p| p.name != "Someone"))
    );
    assert!(detail.deleted_at.is_some());
    let trash_revision = detail
        .revisions
        .iter()
        .find(|revision| revision.operation == "trash")
        .expect("the trash is a revision");
    assert!(trash_revision.undoable);
    assert_eq!(
        trash_revision.before_description.as_deref(),
        Some("Cancelled order")
    );
    assert!(
        trash_revision
            .recorded_local
            .starts_with("2099-06-30T22:00")
    );

    let Answer::TallyExpense(live) = scratch
        .ask(Q::TallyExpense(wire::TallyExpenseRequest {
            expense_id: kept,
            tz: TZ.to_owned(),
        }))
        .expect("a live expense opens")
    else {
        panic!("expense answered as something else");
    };
    assert_eq!(live.memo, None);
    assert!(live.deleted_at.is_none());
}

/// A standing order's schedule is the one summariser's sentence.
#[test]
fn recurring_answers_the_schedule_as_a_sentence() {
    let scratch = Scratch::founded();
    let me = scratch.me();
    let ana = scratch.friend("Ana");
    let house = scratch.group("House", "USD", &[&ana]);
    scratch.run(
        "tally.save_recurring_expense",
        json!({
            "group_id": house, "description": "Rent", "original_amount_minor": 120_000,
            "original_currency": "USD", "settlement_currency": "USD", "paid_by": me,
            "category": "rent", "splits": [{ "party_id": me, "weight": 1 },
                                           { "party_id": ana, "weight": 1 }],
            "rrule": "FREQ=MONTHLY", "anchor_start": "2099-06-01", "tz": TZ,
        }),
    );
    let Answer::TallyRecurring(recurring) = scratch
        .ask(Q::TallyRecurring(wire::TallyRecurringRequest {}))
        .expect("recurring answers")
    else {
        panic!("recurring answered as something else");
    };
    assert_eq!(recurring.templates.len(), 1);
    let rent = &recurring.templates[0];
    assert_eq!(rent.group_name, "House");
    assert!(rent.schedule.is_some(), "a monthly rule is a sentence");
    assert_eq!(
        rent.amount.as_ref().map(|m| (m.minor, m.exponent)),
        Some((120_000, 2))
    );
}

/// A DOOR REFUSAL IS THE `denied` ARM, never an error — and never the data.
#[test]
fn a_door_refusal_is_the_denied_arm() {
    let scratch = Scratch::founded();
    scratch
        .handle
        .with_vault(|vault| {
            let door = VaultDoor::new(vault);
            let answer = answered::<()>(
                &door,
                Err(KitError::Door("tally.read was revoked".to_owned())),
                |()| unreachable!("no data"),
            )
            .expect("a denial is an answer");
            let Answer::Denied(denial) = answer else {
                panic!("a refusal answered as {answer:?}");
            };
            assert_eq!(denial.message.as_deref(), Some("tally.read was revoked"));
            Ok(())
        })
        .expect("the vault is open");
}

/// THE EXPONENTS A SHELL NEEDS TO READ AN ENTRY FORM (#1029): the base
/// currency's on the dashboard, and each remembered rate's FROM currency's —
/// JPY 0 against USD 2 — so the phone scales neither by guessing.
#[test]
fn the_dashboard_states_the_base_exponent_and_each_rates_from_exponent() {
    let scratch = Scratch::founded();
    let me = scratch.me();
    let ana = scratch.friend("Ana");
    scratch.expense(json!({
        "description": "Ramen", "amount_minor": 670, "paid_by": me,
        "category": "food", "spent_on": "2099-06-20",
        "original_currency": "JPY", "settlement_currency": "USD",
        "original_amount_minor": 1_000, "rate_scaled": 670_000, "rate_scale": 6,
        "rate_source": "supplied at entry", "rate_date": "2099-06-20",
        "splits": splits(&[(&me, 335), (&ana, 335)]),
    }));
    let dashboard = scratch.dashboard();
    assert_eq!(dashboard.base_exponent, 2, "USD has cents");
    let rate = dashboard
        .rate_suggestions
        .iter()
        .find(|rate| rate.from_currency == "JPY")
        .expect("the JPY rate is remembered");
    assert_eq!(rate.from_exponent, 0, "JPY has no minor unit");
}

/// THE MEMO IS WRITTEN AND ANSWERED (#1029): `tally.set_expense_memo` writes
/// `knowledge_annotation`'s own columns, `tally_expense` answers it, and an
/// empty note clears it.
#[test]
fn a_memo_set_on_an_expense_is_answered_and_an_empty_one_clears_it() {
    let scratch = Scratch::founded();
    let me = scratch.me();
    let ana = scratch.friend("Ana");
    let expense_id = scratch.expense(json!({
        "description": "Cinema", "amount_minor": 2_500, "paid_by": me,
        "category": "food", "spent_on": "2099-06-20",
        "splits": splits(&[(&me, 1_250), (&ana, 1_250)]),
    }));
    let memo = |scratch: &Scratch| {
        let Answer::TallyExpense(detail) = scratch
            .ask(Q::TallyExpense(wire::TallyExpenseRequest {
                expense_id: expense_id.clone(),
                tz: TZ.to_owned(),
            }))
            .expect("the expense opens")
        else {
            panic!("expense answered as something else");
        };
        detail.memo
    };
    scratch.run(
        "tally.set_expense_memo",
        json!({ "expense_id": expense_id, "note": "Ana owes popcorn too" }),
    );
    assert_eq!(memo(&scratch).as_deref(), Some("Ana owes popcorn too"));
    scratch.run(
        "tally.set_expense_memo",
        json!({ "expense_id": expense_id, "note": "Settled the popcorn" }),
    );
    assert_eq!(
        memo(&scratch).as_deref(),
        Some("Settled the popcorn"),
        "one running memo"
    );
    scratch.run(
        "tally.set_expense_memo",
        json!({ "expense_id": expense_id, "note": "  " }),
    );
    assert_eq!(memo(&scratch), None, "an empty note clears it");
}
