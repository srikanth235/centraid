//! MONEY'S SCREENS (#1135): spending, activity and cash flow, one transaction,
//! the accounts, the categories, the rules, a category's target, recurring
//! charges, search and the statement import. Every decision a person sees is
//! made here; SwiftUI and Compose draw [`wire::ViewState`]. Every amount, its
//! sign and its currency come from [`crate::kit::money`], and nothing here adds
//! two amounts: the core's answers carry every figure, per currency.
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Spending · Activity · Cash flow, with More | [`HOME`] | [`home`] |
//! | One transaction | [`TRANSACTION`] | [`transaction`] |
//! | A category's plan for a month | [`TARGET`] | [`target`] |
//! | Search | [`SEARCH`] | [`search`] |
//! | Recurring charges | [`RECURRING`] | [`recurring`] |
//! | Accounts | [`ACCOUNTS`] | [`accounts`] |
//! | Categories | [`CATEGORIES`] | [`categories`] |
//! | Rules | [`RULES`] | [`rules`] |
//! | Import a statement | [`IMPORT`] | [`import`] |
//!
//! A row that opens a page carries the [`wire::Route`] to push (built by
//! [`routes`]), so a shell never names a screen.
//!
//! ## Pending is not posted
//!
//! A line is `posted` or `void` in the vault, and a view shows exactly that:
//! the chips on a row are the core's flags (`transfer`, `void`, `later`, `no
//! category`), never a state this crate infers from a date or an amount.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub mod accounts;
pub mod categories;
pub mod fold;
pub mod home;
pub mod import;
pub mod recurring;
pub mod rows;
pub mod rules;
pub mod search;
pub mod target;
pub mod transaction;

pub const HOME: &str = "money.home";
pub const TRANSACTION: &str = "money.transaction";
pub const TARGET: &str = "money.target";
pub const SEARCH: &str = "money.search";
pub const RECURRING: &str = "money.recurring";
pub const ACCOUNTS: &str = "money.accounts";
pub const CATEGORIES: &str = "money.categories";
pub const RULES: &str = "money.rules";
pub const IMPORT: &str = "money.import";

/// The tab Money's home is the root of.
pub const TAB: &str = "money";

/// Every Money screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(TRANSACTION, transaction::build)
        .with(TARGET, target::build)
        .with(SEARCH, search::build)
        .with(RECURRING, recurring::build)
        .with(ACCOUNTS, accounts::build)
        .with(CATEGORIES, categories::build)
        .with(RULES, rules::build)
        .with(IMPORT, import::build)
}

/// A runtime with Money's screens and one tab, `money`, rooted at its home.
/// The shell's real runtime composes [`registry`] with the other apps'; this is
/// what Money's own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            routes::home(wire::MoneyDestination::Spending),
        )],
    )
}

/// The routes Money's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{
        ACCOUNTS, CATEGORIES, HOME, IMPORT, RECURRING, RULES, SEARCH, TARGET, TRANSACTION, wire,
    };

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    fn page(parent: &str) -> wire::MoneyPageRoute {
        wire::MoneyPageRoute {
            parent: parent.to_owned(),
        }
    }

    /// Money's home, landing on `destination`.
    #[must_use]
    pub fn home(destination: wire::MoneyDestination) -> wire::Route {
        route(
            HOME,
            wire::route::Args::MoneyHome(wire::MoneyHomeRoute {
                destination: destination as i32,
            }),
        )
    }

    /// One transaction, pushed from the page titled `parent`.
    #[must_use]
    pub fn transaction(txn_id: &str, parent: &str) -> wire::Route {
        route(
            TRANSACTION,
            wire::route::Args::MoneyTransaction(wire::MoneyTransactionRoute {
                txn_id: txn_id.to_owned(),
                parent: parent.to_owned(),
            }),
        )
    }

    /// A category's plan for `month` (`YYYY-MM`) in `currency`.
    #[must_use]
    pub fn target(month: &str, category_id: &str, currency: &str) -> wire::Route {
        route(
            TARGET,
            wire::route::Args::MoneyTarget(wire::MoneyTargetRoute {
                month: month.to_owned(),
                category_id: category_id.to_owned(),
                currency: currency.to_owned(),
            }),
        )
    }

    #[must_use]
    pub fn search(parent: &str) -> wire::Route {
        route(SEARCH, wire::route::Args::MoneySearch(page(parent)))
    }

    #[must_use]
    pub fn recurring(parent: &str) -> wire::Route {
        route(RECURRING, wire::route::Args::MoneyRecurring(page(parent)))
    }

    #[must_use]
    pub fn accounts(parent: &str) -> wire::Route {
        route(ACCOUNTS, wire::route::Args::MoneyAccounts(page(parent)))
    }

    #[must_use]
    pub fn categories(parent: &str) -> wire::Route {
        route(CATEGORIES, wire::route::Args::MoneyCategories(page(parent)))
    }

    #[must_use]
    pub fn rules(parent: &str) -> wire::Route {
        route(RULES, wire::route::Args::MoneyRules(page(parent)))
    }

    #[must_use]
    pub fn import(parent: &str) -> wire::Route {
        route(IMPORT, wire::route::Args::MoneyImport(page(parent)))
    }
}
