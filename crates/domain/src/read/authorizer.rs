//! THE SQLITE AUTHORIZER every read is prepared under (app-plane §2).
//!
//! SQLite resolves every table a statement touches when it prepares, through views, CTEs and
//! subqueries alike, so nothing here parses SQL and nothing slips by in a spelling a parser
//! missed. The policy:
//!
//! - **Read-only.** A `SELECT` and the reading of columns and functions; every other action
//!   (a write, a pragma, an attach, a transaction) is refused.
//! - **A function allowlist.** Pure functions of their arguments; no clock, no randomness, no
//!   extension loading.
//! - **Sealed columns denied for every module**, Locker's included: only `core::locker` reads
//!   them, through the vault, never through a read.
//! - **`reads ∪ across` enforced.** A table outside the declaration is refused at prepare.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

use super::ReadDecl;

/// Columns no read may touch. `(table, column)`.
pub const SEALED: &[(&str, &str)] = &[
    ("locker_item_field", "value_sealed"),
    ("locker_item_field", "value_blob"),
    ("locker_item_passkey", "private_key"),
];

/// The functions a read may call: deterministic, and none that reads a clock or a file.
pub const FUNCTIONS: &[&str] = &[
    "abs",
    "avg",
    "char",
    "coalesce",
    "count",
    "date",
    "datetime",
    "glob",
    "group_concat",
    "ifnull",
    "iif",
    "instr",
    "length",
    "like",
    "likely",
    "lower",
    "ltrim",
    "max",
    "min",
    "nullif",
    "printf",
    "replace",
    "round",
    "rtrim",
    "strftime",
    "substr",
    "substring",
    "sum",
    "time",
    "total",
    "trim",
    "typeof",
    "unlikely",
    "upper",
];

/// What the authorizer saw while one statement prepared.
#[derive(Debug, Default, Clone)]
pub struct Seen {
    /// The tables the statement touches, as SQLite resolved them.
    pub tables: BTreeSet<String>,
    /// The first thing it refused, as a clause.
    pub refusal: Option<String>,
}

/// A policy for one read, and the record it fills in.
#[derive(Debug, Clone)]
pub struct Policy {
    allowed: Arc<BTreeSet<String>>,
    seen: Arc<Mutex<Seen>>,
}

impl Policy {
    /// The policy for `read`: the tables of `reads ∪ across`.
    #[must_use]
    pub fn of(read: &ReadDecl) -> Self {
        Self {
            allowed: Arc::new(read.tables().map(str::to_owned).collect()),
            seen: Arc::default(),
        }
    }

    /// What was seen so far.
    #[must_use]
    pub fn seen(&self) -> Seen {
        self.seen
            .lock()
            .map(|seen| seen.clone())
            .unwrap_or_default()
    }

    /// Judge one action SQLite asks about while it prepares.
    pub fn judge(&self, context: AuthContext<'_>) -> Authorization {
        let refusal = match context.action {
            AuthAction::Select | AuthAction::Recursive => None,
            AuthAction::Function { function_name } => {
                let name = function_name.to_ascii_lowercase();
                (!FUNCTIONS.contains(&name.as_str()))
                    .then(|| format!("calls `{function_name}`, which no read may"))
            }
            AuthAction::Read {
                table_name,
                column_name,
            } => {
                if let Ok(mut seen) = self.seen.lock() {
                    seen.tables.insert(table_name.to_owned());
                }
                if SEALED
                    .iter()
                    .any(|(table, column)| *table == table_name && *column == column_name)
                {
                    Some(format!(
                        "reads the sealed column `{table_name}.{column_name}`, which no read may"
                    ))
                } else if !self.allowed.contains(table_name) {
                    Some(format!(
                        "reads `{table_name}`, which its declaration does not name"
                    ))
                } else {
                    None
                }
            }
            other => Some(format!("asks for {other:?}, and a read only selects")),
        };
        match refusal {
            None => Authorization::Allow,
            Some(why) => {
                if let Ok(mut seen) = self.seen.lock() {
                    seen.refusal.get_or_insert(why);
                }
                Authorization::Deny
            }
        }
    }
}
