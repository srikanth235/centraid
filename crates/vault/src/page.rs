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

// ---------------------------------------------------------------------------
// The keyset page — the shape `crates/core` serves (#1020, lane D2)
// ---------------------------------------------------------------------------

/// A keyset-paged read, as a caller describes it.
///
/// [`RawPage`] takes SQL the caller wrote, which is what the `sql-confinement`
/// rule catches the moment a caller outside this crate wants a page — and
/// rightly: `crates/core` building a `SELECT … ORDER BY … LIMIT` string is
/// `crates/core` knowing the query language. So the *shape* crosses the
/// boundary and the SQL is rendered here.
///
/// **Both order columns must be in `select`.** There is no `key_of` callback:
/// the cursor IS the two columns' values, read off the row, so a projection
/// missing one is a page whose `next` cannot exist.
#[derive(Debug, Clone)]
pub struct KeysetPage {
    /// The shape's name, for logs and budgets.
    pub name: String,
    pub select: Vec<String>,
    pub from: String,
    /// The handler's own predicate, already checked by its author.
    pub predicate: Option<String>,
    pub binds: Vec<Value>,
    pub sort_column: String,
    pub pk_column: String,
    pub descending: bool,
    /// Required, and validated `> 0` rather than defaulted: a zero is a request
    /// for an unbounded read, and defaulting it would serve one.
    pub limit: i64,
    /// `(sort_key, pk)` — the cursor a caller hands back.
    pub after: Option<(String, String)>,
}

/// One page of rows, plus the cursor to ask from next.
#[derive(Debug, Clone)]
pub struct KeysetAnswer {
    pub rows: Vec<RowImage>,
    /// **Absent when the rows ended.** Never a `truncated` flag and never a
    /// cursor that points past the end.
    pub next: Option<(String, String)>,
}

impl Vault {
    /// Serve one keyset page.
    ///
    /// Renders the statement, runs it with the `+1` probe that separates "the
    /// window filled" from "the rows ended", and reads the next cursor off the
    /// last row it serves.
    pub fn keyset_page(&self, page: &KeysetPage) -> Result<KeysetAnswer> {
        if page.limit < 1 {
            return Err(VaultError::InvalidInput {
                name: page.name.clone(),
                detail: "a page limit is required and must be > 0; a default is how an \
                         unbounded read gets written by accident"
                    .to_owned(),
            });
        }
        if page.select.is_empty() {
            return Err(VaultError::InvalidInput {
                name: page.name.clone(),
                detail: "a page query selects nothing".to_owned(),
            });
        }
        for column in [&page.sort_column, &page.pk_column] {
            if !page.select.iter().any(|selected| selected == column) {
                return Err(VaultError::InvalidInput {
                    name: page.name.clone(),
                    detail: format!(
                        "`{column}` is an order column and is not in the projection; the \
                         cursor is read off the row by those two columns"
                    ),
                });
            }
        }

        let limit = page.limit.min(MAX_PAGE_ROWS);
        let direction = if page.descending { "DESC" } else { "ASC" };
        let mut binds = page.binds.clone();
        let mut clauses: Vec<String> = page
            .predicate
            .as_ref()
            .map(|text| vec![format!("({text})")])
            .unwrap_or_default();
        if let Some((sort_key, pk)) = &page.after {
            // A TUPLE COMPARISON on the two order columns. A `>` on the sort
            // column alone would skip every row that ties with the cursor's
            // sort value, and ties are the normal case for a date.
            let comparison = if page.descending { "<" } else { ">" };
            clauses.push(format!(
                "({}, {}) {comparison} (?, ?)",
                crate::log::quoted(&page.sort_column),
                crate::log::quoted(&page.pk_column)
            ));
            binds.push(Value::Text(sort_key.clone()));
            binds.push(Value::Text(pk.clone()));
        }
        let predicate = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let projection = page
            .select
            .iter()
            .map(|column| crate::log::quoted(column))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {projection} FROM {from}{predicate} \
             ORDER BY {sort} {direction}, {pk} {direction} LIMIT {probe}",
            from = crate::log::quoted(&page.from),
            sort = crate::log::quoted(&page.sort_column),
            pk = crate::log::quoted(&page.pk_column),
            probe = limit + 1,
        );

        let mut rows = self.page_raw(&RawPage {
            sql,
            binds,
            limit: limit + 1,
        })?;
        let filled = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
        rows.truncate(usize::try_from(limit).unwrap_or(0));
        let next = if filled {
            rows.last().map(|row| {
                (
                    cursor_text(row, &page.sort_column),
                    cursor_text(row, &page.pk_column),
                )
            })
        } else {
            None
        };
        Ok(KeysetAnswer { rows, next })
    }
}

/// One cell as cursor text.
///
/// A cursor is text whatever the column's storage class, because it is an opaque
/// token a caller hands back. The comparison is then text against text, which
/// is why the sort column must be one whose lexical order is its real order —
/// an ISO timestamp, an id. That is a constraint on the query's author and not
/// something this function can check.
fn cursor_text(row: &RowImage, column: &str) -> String {
    match row.get(column) {
        Some(Value::Text(text)) => text.clone(),
        Some(Value::Integer(int)) => int.to_string(),
        Some(other) => other.to_wire_json(),
        None => String::new(),
    }
}

#[cfg(test)]
mod keyset_tests {
    use super::*;

    #[test]
    fn a_zero_limit_and_a_missing_order_column_are_both_refused() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");

        let base = KeysetPage {
            name: "parties".to_owned(),
            select: vec!["party_id".to_owned(), "created_at".to_owned()],
            from: "core_party".to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: "created_at".to_owned(),
            pk_column: "party_id".to_owned(),
            descending: false,
            limit: 10,
            after: None,
        };
        assert!(vault.keyset_page(&base).is_ok());

        let mut zero = base.clone();
        zero.limit = 0;
        assert!(vault.keyset_page(&zero).is_err());

        let mut unprojected = base.clone();
        unprojected.select = vec!["party_id".to_owned()];
        let error = vault
            .keyset_page(&unprojected)
            .expect_err("an order column outside the projection is refused");
        assert!(error.to_string().contains("created_at"));

        let mut nothing = base;
        nothing.select = Vec::new();
        assert!(vault.keyset_page(&nothing).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cursor_is_absent_when_the_rows_end_and_present_when_they_do_not() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let registry = crate::commands::Registry::with_system_commands().expect("registry");
        let principal = crate::access::Principal::owner("d1");
        for index in 0..5 {
            vault
                .execute(
                    &registry,
                    &principal,
                    &crate::commands::Command::new(
                        "core.add_party",
                        serde_json::json!({ "display_name": format!("P{index}"), "kind": "person" }),
                    ),
                )
                .expect("the command executes");
        }

        let base = KeysetPage {
            name: "parties".to_owned(),
            select: vec!["party_id".to_owned(), "created_at".to_owned()],
            from: "core_party".to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: "created_at".to_owned(),
            pk_column: "party_id".to_owned(),
            descending: false,
            limit: 2,
            after: None,
        };
        let first = vault.keyset_page(&base).expect("a page serves");
        assert_eq!(first.rows.len(), 2);
        let cursor = first.next.clone().expect("there are more rows");

        // AND THE CURSOR WALKS: the second page starts after the first ends,
        // with no row served twice and none skipped.
        let mut second_query = base.clone();
        second_query.after = Some(cursor);
        let second = vault.keyset_page(&second_query).expect("a page serves");
        assert_eq!(second.rows.len(), 2);
        let first_ids: Vec<String> = first
            .rows
            .iter()
            .map(|row| cursor_text(row, "party_id"))
            .collect();
        let second_ids: Vec<String> = second
            .rows
            .iter()
            .map(|row| cursor_text(row, "party_id"))
            .collect();
        assert!(
            first_ids.iter().all(|id| !second_ids.contains(id)),
            "a row was served twice: {first_ids:?} / {second_ids:?}"
        );

        // The last page ends, and its cursor is ABSENT rather than pointing
        // past the end.
        let mut last = base;
        last.limit = 500;
        let whole = vault.keyset_page(&last).expect("a page serves");
        assert_eq!(whole.rows.len(), 6, "five parties plus the vault's owner");
        assert!(whole.next.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
