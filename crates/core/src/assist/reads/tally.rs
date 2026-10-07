//! Tally's four reads: who owes whom, the latest expenses, a search, and a
//! month's spending.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::{App, Card, ReadError, ToolCall, ToolOutput};

use super::{Answer, Env, Query, ROWS, civil, counted, title_or, unexpected};

/// `150.00 USD`: the minor units scaled by the currency's own exponent, which
/// the core states with every figure. No sign: the caller says who owes whom.
fn money(amount: &wire::TallyMoney) -> String {
    let scale = 10_i64.pow(amount.exponent);
    let units = amount.minor.unsigned_abs();
    let whole = units / scale.unsigned_abs();
    let digits = amount.exponent as usize;
    let figure = if digits == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{:0digits$}", units % scale.unsigned_abs())
    };
    format!("{figure} {}", amount.currency)
}

fn money_of(amount: Option<&wire::TallyMoney>) -> String {
    amount.map(money).unwrap_or_default()
}

/// A valuation as words: the total when the core could state one, else each
/// currency on its own — never a sum nobody computed.
fn valuation(valuation: Option<&wire::TallyValuation>) -> Option<String> {
    let valuation = valuation?;
    let parts: Vec<String> = match (&valuation.total, valuation.valued) {
        (Some(total), true) => vec![money(total)],
        _ => valuation.components.iter().map(money).collect(),
    };
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// `tally.balances`: every friend with a position, and the totals.
pub(super) fn balances(env: &Env<'_>, _: &ToolCall) -> Result<ToolOutput, ReadError> {
    let Answer::TallyDashboard(dashboard) =
        env.ask(Query::TallyDashboard(wire::TallyDashboardRequest {
            tz: env.tz.to_owned(),
        }))?
    else {
        return Err(unexpected("tally.balances"));
    };
    let rows: Vec<Card> = dashboard
        .friends
        .iter()
        .filter(|friend| !friend.balances.is_empty())
        .filter_map(|friend| {
            let person = friend.person.as_ref()?;
            // Positive means they owe you (`tally.proto`'s `TallyFriendBalance`).
            let said = friend
                .balances
                .iter()
                .map(|amount| {
                    if amount.minor > 0 {
                        format!("owes you {}", money(amount))
                    } else {
                        format!("you owe {}", money(amount))
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            Some(Card::new(App::Tally, "friend", &person.party_id, &person.name).subtitle(said))
        })
        .take(ROWS as usize)
        .collect();
    let mut output = ToolOutput::of_rows(
        format!(
            "{} with a balance",
            counted(rows.len(), "friend", "friends")
        ),
        rows,
    );
    if let Some(owed) = valuation(dashboard.owed.as_ref()) {
        output.facts.push(format!("Owed to you in total: {owed}"));
    }
    if let Some(owe) = valuation(dashboard.owe.as_ref()) {
        output.facts.push(format!("You owe in total: {owe}"));
    }
    Ok(output)
}

fn expense_card(row: &wire::TallyExpenseRow) -> Card {
    let paid_by = row
        .paid_by
        .as_ref()
        .map_or("", |person| person.name.as_str());
    let meta = [row.spent_on.as_str(), row.group_name.as_str(), paid_by]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    Card::new(
        App::Tally,
        "expense",
        &row.expense_id,
        title_or(Some(&row.description), "", "Expense"),
    )
    .subtitle(money_of(row.amount.as_ref()))
    .meta(meta)
}

/// `tally.recent`: the dashboard's activity, expenses only — a settlement has
/// no screen of its own to tap through to.
pub(super) fn recent(env: &Env<'_>, _: &ToolCall) -> Result<ToolOutput, ReadError> {
    let Answer::TallyDashboard(dashboard) =
        env.ask(Query::TallyDashboard(wire::TallyDashboardRequest {
            tz: env.tz.to_owned(),
        }))?
    else {
        return Err(unexpected("tally.recent"));
    };
    let rows: Vec<Card> = dashboard
        .activity
        .iter()
        .filter_map(|activity| match activity.row.as_ref()? {
            wire::tally_activity_row::Row::Expense(expense) => Some(
                Card::new(
                    App::Tally,
                    "expense",
                    &expense.expense_id,
                    title_or(Some(&expense.description), "", "Expense"),
                )
                .subtitle(money_of(expense.amount.as_ref()))
                .meta(
                    [expense.date.as_str(), expense.group_name.as_str()]
                        .into_iter()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            ),
            wire::tally_activity_row::Row::Settlement(_) => None,
        })
        .take(ROWS as usize)
        .collect();
    Ok(ToolOutput::of_rows(
        format!("{} latest", counted(rows.len(), "expense", "expenses")),
        rows,
    ))
}

/// `tally.search`.
pub(super) fn search(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let term = call.arg("term").unwrap_or_default();
    let Answer::TallySearch(answer) = env.ask(Query::TallySearch(wire::TallySearchRequest {
        term: term.to_owned(),
        limit: ROWS,
    }))?
    else {
        return Err(unexpected("tally.search"));
    };
    let rows: Vec<Card> = answer.results.iter().map(expense_card).collect();
    let mut output = ToolOutput::of_rows(
        format!(
            "{} matching \"{term}\"",
            counted(rows.len(), "expense", "expenses")
        ),
        rows,
    );
    output.total = output.total.max(answer.total_matches as usize);
    Ok(output)
}

/// `tally.spending`: a month's totals by category. Facts and no cards: a
/// category is a total, and has no row to open.
pub(super) fn spending(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let month = if call.arg("month") == Some("last") {
        // The month before the month the core calls this one: ask for this
        // month's `today`, then step back.
        let Answer::TallySpending(this) =
            env.ask(Query::TallySpending(wire::TallySpendingRequest {
                tz: env.tz.to_owned(),
                month: String::new(),
            }))?
        else {
            return Err(unexpected("tally.spending"));
        };
        civil::previous_month(&this.today).ok_or_else(|| unexpected("tally.spending"))?
    } else {
        String::new()
    };
    let Answer::TallySpending(answer) =
        env.ask(Query::TallySpending(wire::TallySpendingRequest {
            tz: env.tz.to_owned(),
            month,
        }))?
    else {
        return Err(unexpected("tally.spending"));
    };
    let total = answer
        .month_total
        .iter()
        .map(money)
        .collect::<Vec<_>>()
        .join(", ");
    let mut output = ToolOutput {
        headline: if total.is_empty() {
            format!("No spending in {}", answer.month)
        } else {
            format!("Spending in {}: {total}", answer.month)
        },
        ..ToolOutput::default()
    };
    output.facts = answer
        .categories
        .iter()
        .take(8)
        .map(|category| {
            format!(
                "{}: {}",
                category.category,
                money_of(category.total.as_ref())
            )
        })
        .collect();
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn amount(minor: i64, exponent: u32, currency: &str) -> wire::TallyMoney {
        wire::TallyMoney {
            minor,
            currency: currency.to_owned(),
            exponent,
        }
    }

    #[test]
    fn money_scales_by_the_currencys_own_exponent_and_drops_the_sign() {
        assert_eq!(money(&amount(15_000, 2, "USD")), "150.00 USD");
        assert_eq!(money(&amount(-4_820, 2, "USD")), "48.20 USD");
        assert_eq!(money(&amount(5, 2, "EUR")), "0.05 EUR");
        assert_eq!(money(&amount(1_200, 0, "JPY")), "1200 JPY");
        assert_eq!(money(&amount(1_234, 3, "BHD")), "1.234 BHD");
    }

    #[test]
    fn a_valuation_states_the_total_or_each_currency_never_a_sum_nobody_computed() {
        let valued = wire::TallyValuation {
            valued: true,
            total: Some(amount(100, 2, "USD")),
            components: vec![amount(100, 2, "USD")],
        };
        assert_eq!(valuation(Some(&valued)).as_deref(), Some("1.00 USD"));
        let mixed = wire::TallyValuation {
            valued: false,
            total: None,
            components: vec![amount(100, 2, "USD"), amount(200, 2, "EUR")],
        };
        assert_eq!(
            valuation(Some(&mixed)).as_deref(),
            Some("1.00 USD, 2.00 EUR")
        );
        assert_eq!(valuation(None), None);
    }
}
