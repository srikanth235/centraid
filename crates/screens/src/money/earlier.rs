//! MONEY'S EARLIER VERSIONS: the kit's one earlier-versions screen with Money's spec (#1185).
//!
//! Only what the member sets on a transaction ever has versions: the name they gave it and its
//! category (the bank's amount, day and account never change, and the bank's own words are not
//! the member's to edit). A version's line is the ones it held, as the page words them: `Corner
//! grocer · Groceries`. A version that changed only something the page does not show (its status)
//! reads "Other details".

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::fold;
use crate::catalog::load;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::shared;

/// Money's earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "money",
    noun: shared::trash_noun_transaction,
    denied: |locale, _| fold::denied(locale),
    parts,
    know: Some(know),
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

/// The names of the categories, as the page words a category.
fn know(ctx: &Ctx, _txn_id: &str) -> Names {
    let mut names = Names::new();
    if let Reading::Data(categories) =
        read::read(ctx, load::money::Categories {}, |answer| match answer {
            Answer::MoneyCategories(categories) => Some(categories),
            _ => None,
        })
    {
        for group in &categories.groups {
            for category in &group.categories {
                names.insert(category.category_id.clone(), category.label.clone());
            }
        }
    }
    names
}

/// The one line a transaction's fields read as: the name, then the category.
fn parts(look: &Look, fields: &[Field]) -> Vec<String> {
    let own = |name: &str| {
        fields
            .iter()
            .find(|field| field.name == name)
            .and_then(|field| field.value.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    [
        own("entity.title").map(str::to_owned),
        own("txn.category_id").and_then(|id| look.names.get(id).cloned()),
    ]
    .into_iter()
    .flatten()
    .collect()
}
