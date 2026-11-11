//! MONEY'S EXPORT (`money.export`, #1185), the kit's one export screen over `txn.export_csv`: the
//! rows are "All accounts" and each account, and the spreadsheet file the command answers goes to
//! the OS save sheet once the owner check passed.

use centraid_api_proto::core_v1 as wire;

use super::fold;
use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec};
use crate::kit::owner::NoPasscode;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, money as words};

/// The row that exports every account.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: "money",
    title: words::export_title,
    lede: words::export_lede,
    back_label: words::app_title,
    denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

/// The gate drawn when the vault will not let Money read.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    let mut gate = fold::denied(locale);
    gate.receipt = denial.code.clone().unwrap_or_default();
    gate
}

fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let accounts = read::read(ctx, load::money::Accounts {}, |answer| match answer {
        wire::app_query_response::Answer::MoneyAccounts(accounts) => Some(accounts),
        _ => None,
    });
    match accounts {
        Reading::Data(accounts) => {
            let mut rows = vec![Choice {
                key: ALL.to_owned(),
                label: words::export_all(ctx.locale()),
                value: String::new(),
            }];
            rows.extend(
                accounts
                    .on_budget
                    .iter()
                    .chain(&accounts.off_budget)
                    .map(|account| Choice {
                        key: account.account_id.clone(),
                        label: account.name.clone(),
                        value: String::new(),
                    }),
            );
            Reading::Data(rows)
        }
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

/// The spreadsheet file of one account (`account_id`) or of one transaction (`transaction_id`),
/// through the same command the export screen calls.
pub fn file(
    ctx: &Ctx,
    account_id: Option<&str>,
    transaction_id: Option<&str>,
) -> Result<export::ExportFile, String> {
    // undo-exempt: an export writes nothing (`writes_nothing` in the manifest), so there is nothing to take back.
    let settled = kit_act::act(
        ctx,
        act::money::ExportCsv {
            account_id: account_id.map_or(Field::Keep, |id| Field::Is(id.to_owned())),
            transaction_id: transaction_id.map_or(Field::Keep, |id| Field::Is(id.to_owned())),
        },
        &kit_act::key(
            &[
                "txn.export_csv",
                account_id.unwrap_or_default(),
                transaction_id.unwrap_or_default(),
            ],
            kit_act::fresh(),
        ),
    );
    if transaction_id.is_some()
        && settled.committed
        && crate::kit::transfer::count(&settled.output, "count") == 0
    {
        return Err(String::new());
    }
    export::file_of(&settled, "text/csv", "Transactions.csv")
}

fn export(ctx: &Ctx, key: &str) -> Result<export::ExportFile, String> {
    file(ctx, (key != ALL).then_some(key), None)
}
