//! THE BALANCE ENGINE. Pure, and the one place that decides who owes whom.
//!
//! Ported from `packages/blueprints/src/tally-balance.ts` and
//! `packages/blueprints/src/tally-simplify.ts`, whose doctrine this module
//! keeps: **balances are never stored.** They are derived at read time by this
//! one fold, and the simplification proposal is derived the same way and
//! written nowhere (`packages/blueprints/apps/tally/app.json`'s description;
//! #996 ruling R22).
//!
//! Three rules that are load-bearing and easy to lose in a port:
//!
//! 1. **Payer rows are ground facts** (#883, ruling O-payers). A fold that
//!    finds none is reading an expense the vault never finished writing, and
//!    must show that rather than invent a fallback — so [`expense_payers`]
//!    filters rather than defaulting to `paid_by`.
//! 2. **Shares and payments are matched off, not pro-rated**
//!    (`tally-balance.ts:47-55`). Pro-rating rounds per share, the rounded
//!    portions stop adding back to what each payer put down, and the pairwise
//!    view stops reconciling with the per-member fold. Matching exhausts both
//!    sides exactly, with no remainder to place.
//! 3. **The pairwise matrix is a refinement of the net, never a second
//!    opinion**: every row sums to that member's net with the sign flipped.
//!    `crates/apps/tally/tests/parity.rs` pins that against v0's own answers.
//!
//! **The order every fold sorts by** is `amount descending, then party id`.
//! v0 uses `localeCompare` for the id half (`tally-balance.ts:63`,
//! `tally-simplify.ts:43`), and this port uses byte order (#1020, apps seam 4).
//! For the ids the product mints — ULIDs and UUIDs, ASCII hex and Crockford
//! base32 — ICU collation and byte order agree on every pair, so the two orders
//! are the same order. The divergence is reachable only for a party id
//! containing non-ASCII text, which no minting path produces; documented rather
//! than reconciled, because a `localeCompare` port would put ICU in the core
//! for a case that cannot occur. **A proposal must not reshuffle between
//! reads** (`tally-simplify.ts:41-44`), and byte order is the more stable of
//! the two about that: it does not depend on a host locale.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::money::{Money, money};

/// The minimal resident facts the fold consumes.
///
/// Keeping this a value rather than a vault read is what lets the same
/// computation serve the shipped query, the convergence tests and the phone
/// directly (#922 E7, ruling SB-tally).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BalanceExpense {
    /// `None` for a group-less 1:1 expense (GAPS #4).
    pub group_id: Option<String>,
    pub paid_by: String,
    pub amount_minor: i64,
    /// The RESOLVED shares, per party.
    pub splits: BTreeMap<String, i64>,
    /// Who actually put money down. Required; see rule 1 above.
    pub payers: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BalanceSettlement {
    pub group_id: Option<String>,
    pub from_party: String,
    pub to_party: String,
    pub amount_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BalanceData {
    /// Current membership, per group. Current STATE — the ledger is the
    /// durable history, which is why a departed member still appears below.
    pub members_by_group: BTreeMap<String, Vec<String>>,
    pub expenses: Vec<BalanceExpense>,
    pub settlements: Vec<BalanceSettlement>,
}

/// One participant owing one payer, in minor units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribution {
    pub from: String,
    pub to: String,
    pub amount_minor: i64,
}

/// Who paid what on one expense, zero contributions dropped.
pub fn expense_payers(expense: &BalanceExpense) -> Vec<(String, i64)> {
    expense
        .payers
        .iter()
        .filter(|(_, paid)| **paid != 0)
        .map(|(party, paid)| (party.clone(), *paid))
        .collect()
}

/// `amount descending, then party id ascending` — see the module note.
fn ordered(mut entries: Vec<(String, i64)>) -> Vec<(String, i64)> {
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    entries
}

/// Who owes whom for ONE expense. THE single attribution rule — every pairwise
/// view calls this, so no two can disagree about who a share is owed to.
pub fn attribute_expense(expense: &BalanceExpense) -> Vec<Attribution> {
    let payers = ordered(
        expense_payers(expense)
            .into_iter()
            .filter(|(_, paid)| *paid > 0)
            .collect(),
    );
    let participants = ordered(
        expense
            .splits
            .iter()
            .filter(|(_, share)| **share > 0)
            .map(|(party, share)| (party.clone(), *share))
            .collect(),
    );

    let mut attributions = Vec::new();
    let mut owing = 0usize;
    let mut paying = 0usize;
    let mut share_left = participants.first().map_or(0, |entry| entry.1);
    let mut paid_left = payers.first().map_or(0, |entry| entry.1);
    while owing < participants.len() && paying < payers.len() {
        let amount = share_left.min(paid_left);
        if amount <= 0 {
            break;
        }
        attributions.push(Attribution {
            from: participants[owing].0.clone(),
            to: payers[paying].0.clone(),
            amount_minor: amount,
        });
        share_left -= amount;
        paid_left -= amount;
        if share_left == 0 {
            owing += 1;
            share_left = participants.get(owing).map_or(0, |entry| entry.1);
        }
        if paid_left == 0 {
            paying += 1;
            paid_left = payers.get(paying).map_or(0, |entry| entry.1);
        }
    }
    attributions
}

/// Net per member within a group, in minor units. **Positive = gets money
/// back.** One sign convention for the whole app.
pub fn group_net(data: &BalanceData, group_id: &str) -> BTreeMap<String, i64> {
    let mut net: BTreeMap<String, i64> = BTreeMap::new();
    // Every CURRENT member is seeded at zero, so a member who owes nothing is
    // still on the roster rather than missing from it.
    for party in data.members_by_group.get(group_id).into_iter().flatten() {
        net.insert(party.clone(), 0);
    }
    for expense in &data.expenses {
        if expense.group_id.as_deref() != Some(group_id) {
            continue;
        }
        for (party, paid) in expense_payers(expense) {
            *net.entry(party).or_insert(0) += paid;
        }
        for (party, share) in &expense.splits {
            *net.entry(party.clone()).or_insert(0) -= share;
        }
    }
    for settlement in &data.settlements {
        if settlement.group_id.as_deref() != Some(group_id) {
            continue;
        }
        *net.entry(settlement.from_party.clone()).or_insert(0) += settlement.amount_minor;
        *net.entry(settlement.to_party.clone()).or_insert(0) -= settlement.amount_minor;
    }
    net
}

/// Who owes whom inside a group, before any simplification.
/// `pair[a][b]` is positive when **a owes b**; the matrix is antisymmetric by
/// construction.
pub fn group_pair_nets(
    data: &BalanceData,
    group_id: &str,
) -> BTreeMap<String, BTreeMap<String, i64>> {
    let mut pair: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for party in data.members_by_group.get(group_id).into_iter().flatten() {
        pair.entry(party.clone()).or_default();
    }
    let owe =
        |pair: &mut BTreeMap<String, BTreeMap<String, i64>>, from: &str, to: &str, amount: i64| {
            if from == to || amount == 0 {
                return;
            }
            pair.entry(from.to_owned()).or_default();
            pair.entry(to.to_owned()).or_default();
            *pair
                .get_mut(from)
                .expect("just inserted")
                .entry(to.to_owned())
                .or_insert(0) += amount;
            *pair
                .get_mut(to)
                .expect("just inserted")
                .entry(from.to_owned())
                .or_insert(0) -= amount;
        };
    for expense in &data.expenses {
        if expense.group_id.as_deref() != Some(group_id) {
            continue;
        }
        for attribution in attribute_expense(expense) {
            owe(
                &mut pair,
                &attribution.from,
                &attribution.to,
                attribution.amount_minor,
            );
        }
    }
    for settlement in &data.settlements {
        if settlement.group_id.as_deref() != Some(group_id) {
            continue;
        }
        // Paying someone reduces what you owe them.
        owe(
            &mut pair,
            &settlement.from_party,
            &settlement.to_party,
            -settlement.amount_minor,
        );
    }
    pair
}

/// How many directed debts stand between members of the group right now.
pub fn open_debt_count(pair: &BTreeMap<String, BTreeMap<String, i64>>) -> usize {
    pair.values()
        .flat_map(BTreeMap::values)
        .filter(|amount| **amount > 0)
        .count()
}

/// A proposed payment, in the GROUP's currency (#996 ruling R22) — a group is
/// one ledger in one money, and a proposed payment carries the money it is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transfer {
    pub from: String,
    pub to: String,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Simplification {
    pub opted_in: bool,
    pub transfers: Vec<Transfer>,
    pub debts_before: usize,
    pub payments_after: usize,
}

/// Min-cash-flow: each transfer zeroes a party, so at most `n - 1` payments;
/// integer minor units, so it terminates.
pub fn minimal_transfers(net: &BTreeMap<String, i64>, currency: &str) -> Vec<Transfer> {
    let mut debtors = Vec::new();
    let mut creditors = Vec::new();
    for (party, amount) in net {
        if *amount < 0 {
            debtors.push((party.clone(), -amount));
        } else if *amount > 0 {
            creditors.push((party.clone(), *amount));
        }
    }
    // A proposal must not reshuffle between reads.
    let mut debtors = ordered(debtors);
    let mut creditors = ordered(creditors);

    let mut transfers = Vec::new();
    let mut debtor_at = 0usize;
    let mut creditor_at = 0usize;
    while debtor_at < debtors.len() && creditor_at < creditors.len() {
        let amount = debtors[debtor_at].1.min(creditors[creditor_at].1);
        if amount > 0 {
            transfers.push(Transfer {
                from: debtors[debtor_at].0.clone(),
                to: creditors[creditor_at].0.clone(),
                amount: money(amount, currency),
            });
        }
        debtors[debtor_at].1 -= amount;
        creditors[creditor_at].1 -= amount;
        if debtors[debtor_at].1 == 0 {
            debtor_at += 1;
        }
        if creditors[creditor_at].1 == 0 {
            creditor_at += 1;
        }
    }
    transfers
}

/// Pure and read-time: no proposal table, no stored balance. Simplification is
/// **off unless a group opts in**, and the opt-in flag is the only thing the
/// vault stores (`tally-simplify.ts:1-2`).
pub fn simplification(
    data: &BalanceData,
    group_id: &str,
    opted_in: bool,
    currency: &str,
) -> Simplification {
    let debts_before = open_debt_count(&group_pair_nets(data, group_id));
    if !opted_in {
        return Simplification {
            opted_in: false,
            transfers: Vec::new(),
            debts_before,
            payments_after: debts_before,
        };
    }
    let transfers = minimal_transfers(&group_net(data, group_id), currency);
    Simplification {
        opted_in: true,
        payments_after: transfers.len(),
        transfers,
        debts_before,
    }
}

/// Every party any part of the ledger names, whether or not they are still a
/// member.
///
/// **Circle membership is current state, the ledger durable history**
/// (`queries/dashboard.ts:400-424`): a member who left must stay nameable
/// wherever an expense or settlement still refers to them, or a group's ledger
/// prints "Someone" against a row the member remembers.
pub fn parties_on_the_ledger(data: &BalanceData) -> BTreeSet<String> {
    let mut parties: BTreeSet<String> = BTreeSet::new();
    for roster in data.members_by_group.values() {
        parties.extend(roster.iter().cloned());
    }
    for expense in &data.expenses {
        parties.insert(expense.paid_by.clone());
        parties.extend(expense.splits.keys().cloned());
        parties.extend(expense.payers.keys().cloned());
    }
    for settlement in &data.settlements {
        parties.insert(settlement.from_party.clone());
        parties.insert(settlement.to_party.clone());
    }
    parties
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expense(
        paid_by: &str,
        amount: i64,
        splits: &[(&str, i64)],
        payers: &[(&str, i64)],
    ) -> BalanceExpense {
        BalanceExpense {
            group_id: Some("g".to_owned()),
            paid_by: paid_by.to_owned(),
            amount_minor: amount,
            splits: splits
                .iter()
                .map(|(party, share)| ((*party).to_owned(), *share))
                .collect(),
            payers: payers
                .iter()
                .map(|(party, paid)| ((*party).to_owned(), *paid))
                .collect(),
        }
    }

    fn data(members: &[&str], expenses: Vec<BalanceExpense>) -> BalanceData {
        BalanceData {
            members_by_group: [(
                "g".to_owned(),
                members.iter().map(|party| (*party).to_owned()).collect(),
            )]
            .into_iter()
            .collect(),
            expenses,
            settlements: Vec::new(),
        }
    }

    /// THE reconciliation property, stated as v0 states it
    /// (`tally-balance.ts:131-136`): every pair row sums to that member's net
    /// with the sign flipped. If this holds, the pairwise view and the
    /// per-member fold cannot disagree.
    fn assert_reconciles(data: &BalanceData, group_id: &str) {
        let net = group_net(data, group_id);
        let pair = group_pair_nets(data, group_id);
        for (party, row) in &pair {
            let owed: i64 = row.values().sum();
            assert_eq!(
                owed,
                -net.get(party).copied().unwrap_or(0),
                "the pair row of {party} does not reconcile with the net"
            );
        }
    }

    #[test]
    fn no_payer_rows_is_not_a_fallback_to_paid_by() {
        let mut orphan = expense("me", 1_000, &[("me", 500), ("a", 500)], &[]);
        orphan.payers.clear();
        assert!(expense_payers(&orphan).is_empty());
        assert!(attribute_expense(&orphan).is_empty());
    }

    #[test]
    fn an_odd_amount_over_three_sharers_exhausts_both_sides() {
        let one = expense(
            "me",
            10_001,
            &[("me", 3_334), ("a", 3_334), ("b", 3_333)],
            &[("me", 10_001)],
        );
        let attributions = attribute_expense(&one);
        let total: i64 = attributions
            .iter()
            .map(|attribution| attribution.amount_minor)
            .sum();
        assert_eq!(total, 10_001, "matching leaves no remainder to place");
        assert_reconciles(&data(&["me", "a", "b"], vec![one]), "g");
    }

    #[test]
    fn two_payers_still_reconcile() {
        let one = expense(
            "a",
            24_000,
            &[("me", 8_000), ("a", 8_000), ("b", 8_000)],
            &[("a", 14_000), ("b", 10_000)],
        );
        assert_reconciles(&data(&["me", "a", "b"], vec![one]), "g");
    }

    #[test]
    fn a_settlement_reduces_only_what_you_owe_that_person() {
        let mut ledger = data(
            &["me", "a"],
            vec![expense(
                "me",
                10_000,
                &[("me", 5_000), ("a", 5_000)],
                &[("me", 10_000)],
            )],
        );
        ledger.settlements.push(BalanceSettlement {
            group_id: Some("g".to_owned()),
            from_party: "a".to_owned(),
            to_party: "me".to_owned(),
            amount_minor: 5_000,
        });
        let pair = group_pair_nets(&ledger, "g");
        assert_eq!(pair["a"].get("me").copied(), Some(0));
        assert_eq!(open_debt_count(&pair), 0);
        assert_reconciles(&ledger, "g");
    }

    #[test]
    fn a_departed_member_is_still_on_the_matrix() {
        let ledger = data(
            &["me", "a"],
            vec![expense(
                "me",
                9_000,
                &[("me", 3_000), ("a", 3_000), ("gone", 3_000)],
                &[("me", 9_000)],
            )],
        );
        let pair = group_pair_nets(&ledger, "g");
        assert!(
            pair.contains_key("gone"),
            "the ledger is durable history; membership is current state"
        );
        assert_eq!(pair["gone"].get("me").copied(), Some(3_000));
        assert_reconciles(&ledger, "g");
    }

    #[test]
    fn simplification_is_off_unless_a_group_opts_in() {
        let ledger = data(
            &["me", "a", "b", "c"],
            vec![expense(
                "me",
                12_000,
                &[("me", 3_000), ("a", 3_000), ("b", 3_000), ("c", 3_000)],
                &[("me", 12_000)],
            )],
        );
        let off = simplification(&ledger, "g", false, "GBP");
        assert!(off.transfers.is_empty());
        assert_eq!(off.payments_after, off.debts_before);
        let on = simplification(&ledger, "g", true, "GBP");
        assert_eq!(on.transfers.len(), 3);
        assert!(
            on.payments_after <= on.debts_before,
            "a proposal that needs more payments than it replaces is not a simplification"
        );
        // At most n - 1 payments, because each transfer zeroes a party.
        assert!(on.transfers.len() <= 3);
    }

    #[test]
    fn the_transfer_order_does_not_reshuffle_between_reads() {
        let net: BTreeMap<String, i64> = [("a", -300), ("b", -300), ("c", 600)]
            .into_iter()
            .map(|(party, amount)| (party.to_owned(), amount))
            .collect();
        let first = minimal_transfers(&net, "GBP");
        let again = minimal_transfers(&net, "GBP");
        assert_eq!(first, again);
        // Equal amounts break on the party id, ascending.
        assert_eq!(first[0].from, "a");
    }
}
