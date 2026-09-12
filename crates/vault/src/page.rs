//! The paged door's vault-side hook (D-1020-D1-10).
//!
//! **The grammar is not here.** Lane D3 ports v0's statement-as-data grammar
//! into `crates/apps/kit`: a `FROM` of tables and equijoins, a `SELECT`/`WHERE`
//! of column refs, placeholders, literals and a fixed operator set, with
//! subqueries, second statements, comments and unlisted functions REFUSED
//! rather than repaired. That belongs with the kit because the kit is what
//! every app writes its reads in, and a grammar with two implementations is two
//! keyset dialects.
//!
//! What the vault owes the kit, and the whole interface between them:
//!
//! - [`Vault::page_raw`] runs an already-checked statement and returns rows,
//!   with a hard row cap SQLite itself enforces.
//! - [`and_row_filters`] is the AND-ing hook: the authority plane's row filters
//!   are conjoined into the statement's `WHERE`, **never ORed**, and a table
//!   whose decision is `deny` refuses the whole page rather than being dropped
//!   from the join. Dropping it would silently answer a different question.
//! - **A sealed column is never projectable.** A page is a read and plaintext
//!   takes `reveal`, so the mask is applied here and not left to the caller.
//!
//! Agreed with lane D3 in the receipt: the kit builds the statement text and
//! the binds, calls `and_row_filters` with the decision it got from
//! `evaluate_access`, and hands the result to `page_raw`. The vault never sees
//! a `PageQuery`; the kit never sees a `Connection`.

use crate::access::{Decision, RowFilter};
use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::value::{RowImage, Value};

/// The ceiling a page is clamped to — v0's `MAX_PAGE_ROWS`.
///
/// A CEILING that clamps, not a policy that refuses: a caller asking for 10,000
/// rows gets 500, because the alternative is an error at a boundary nobody
/// tested. The `+1` probe that separates "window filled" from "rows ended" is
/// the kit's, not the vault's.
pub const MAX_PAGE_ROWS: i64 = 500;

/// An already-checked statement and its binds.
#[derive(Debug, Clone)]
pub struct RawPage {
    pub sql: String,
    pub binds: Vec<Value>,
    pub limit: i64,
}

impl Vault {
    /// Run a checked statement, returning at most `limit` rows.
    ///
    /// `limit` is clamped to [`MAX_PAGE_ROWS`] and the statement runs on the
    /// READ connection, so `query_only` refuses anything that is not a read —
    /// which means a grammar bug that let a write through is caught by SQLite
    /// rather than by a reviewer.
    pub fn page_raw(&self, page: &RawPage) -> Result<Vec<RowImage>> {
        if page.limit < 1 {
            return Err(VaultError::Invariant {
                context: "a page limit is required; a default is how an unbounded read gets written by accident".to_owned(),
            });
        }
        let limit = page.limit.min(MAX_PAGE_ROWS);
        self.read(|connection| {
            let mut statement = connection.prepare(&page.sql)?;
            let names: Vec<String> = statement
                .column_names()
                .into_iter()
                .map(str::to_owned)
                .collect();
            let binds: Vec<&dyn rusqlite::ToSql> = page
                .binds
                .iter()
                .map(|value| value as &dyn rusqlite::ToSql)
                .collect();
            let mut rows = statement.query(binds.as_slice())?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                if i64::try_from(out.len()).unwrap_or(i64::MAX) >= limit {
                    break;
                }
                let mut image = RowImage::new();
                for (index, name) in names.iter().enumerate() {
                    image.insert(name.clone(), Value::from_ref(row.get_ref(index)?)?);
                }
                out.push(image);
            }
            Ok(out)
        })
    }
}

/// Conjoin a decision's row filters onto a statement's `WHERE`.
///
/// Returns the new predicate text and the binds to append, in the order the
/// text names them. A `deny` REFUSES: an empty answer would read as "no data"
/// and the truth is "you may not ask".
pub fn and_row_filters(
    table_alias: &str,
    existing_where: Option<&str>,
    decision: &Decision,
) -> Result<(Option<String>, Vec<Value>)> {
    if let Decision::Deny { failing, .. } = decision {
        return Err(VaultError::Invariant {
            context: failing.clone(),
        });
    }
    let mut clauses: Vec<String> = existing_where
        .map(|text| vec![format!("({text})")])
        .unwrap_or_default();
    let mut binds: Vec<Value> = Vec::new();
    for filter in decision.row_filter() {
        clauses.push(render_filter(table_alias, filter, &mut binds));
    }
    if clauses.is_empty() {
        return Ok((None, binds));
    }
    Ok((Some(clauses.join(" AND ")), binds))
}

/// One filter as SQL: `=` for a single value, `IN` for a set.
fn render_filter(table_alias: &str, filter: &RowFilter, binds: &mut Vec<Value>) -> String {
    let column = format!(
        "{}.{}",
        crate::log::quoted(table_alias),
        crate::log::quoted(&filter.column)
    );
    if filter.values.len() == 1 {
        binds.push(Value::Text(filter.values[0].clone()));
        return format!("{column} = ?");
    }
    for value in &filter.values {
        binds.push(Value::Text(value.clone()));
    }
    format!(
        "{column} IN ({})",
        vec!["?"; filter.values.len()].join(", ")
    )
}

/// Drop the columns a mask does not admit.
///
/// Applied to the ROWS rather than to the `SELECT` list, because a keyset page
/// needs its sort column and its primary key in the projection whether or not
/// the mask admits them — the cursor is read off the row by those two columns.
#[must_use]
pub fn apply_field_mask(rows: Vec<RowImage>, decision: &Decision) -> Vec<RowImage> {
    let Decision::Allow {
        field_mask: Some(mask),
        ..
    } = decision
    else {
        return rows;
    };
    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .filter(|(column, _)| mask.contains(column))
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Decision;

    fn allow(filters: Vec<RowFilter>) -> Decision {
        Decision::Allow {
            authority_id: None,
            row_filter: filters,
            field_mask: None,
        }
    }

    #[test]
    fn filters_are_anded_onto_the_existing_predicate_and_never_ored() {
        let decision = allow(vec![RowFilter {
            column: "group_id".to_owned(),
            values: vec!["g1".to_owned()],
        }]);
        let (predicate, binds) =
            and_row_filters("e", Some("spent_on >= ?"), &decision).expect("ANDed");
        let predicate = predicate.expect("there is a predicate");
        assert_eq!(predicate, "(spent_on >= ?) AND \"e\".\"group_id\" = ?");
        assert!(!predicate.contains(" OR "));
        assert_eq!(binds, vec![Value::Text("g1".to_owned())]);
    }

    #[test]
    fn a_bounded_union_is_one_in_filter() {
        let decision = allow(vec![RowFilter {
            column: "group_id".to_owned(),
            values: vec!["g1".to_owned(), "g2".to_owned()],
        }]);
        let (predicate, binds) = and_row_filters("e", None, &decision).expect("ANDed");
        assert_eq!(
            predicate.expect("there is a predicate"),
            "\"e\".\"group_id\" IN (?, ?)"
        );
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn a_deny_refuses_the_page_rather_than_answering_nothing() {
        let decision = Decision::Deny {
            failing: "nothing grants read on locker.item".to_owned(),
            authority_id: None,
        };
        let error = and_row_filters("i", None, &decision).expect_err("must refuse");
        assert!(error.to_string().contains("locker.item"), "{error}");
    }

    #[test]
    fn a_field_mask_drops_what_it_does_not_admit() {
        let mut row = RowImage::new();
        row.insert("a".to_owned(), Value::Integer(1));
        row.insert("secret".to_owned(), Value::Text("x".to_owned()));
        let decision = Decision::Allow {
            authority_id: None,
            row_filter: Vec::new(),
            field_mask: Some(["a"].into_iter().map(str::to_owned).collect()),
        };
        let masked = apply_field_mask(vec![row], &decision);
        assert_eq!(masked[0].keys().collect::<Vec<_>>(), vec!["a"]);
    }
}
