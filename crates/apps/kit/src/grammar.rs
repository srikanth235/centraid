//! THE DOOR'S GRAMMAR (#996 ruling W4-D2, ported for #1020).
//!
//! Ported from `packages/vault/src/gateway/paged-door.ts:15-29`, which states
//! why it is a grammar and not a sanitiser: a statement the door cannot take
//! apart is a statement the door cannot check. To apply a field mask it must
//! know which columns are projected; to apply a row filter it must know which
//! tables are read. Escaping strings answers neither question.
//!
//! So a statement's three text parts are parsed against a deliberately small
//! grammar — a `from` that is tables and equijoins, a `select` and a `where`
//! that are column references, placeholders, literals and a fixed operator set
//! — and **anything outside it is refused rather than repaired**. A subquery, a
//! second statement, a comment, a function the list does not name: all refused.
//!
//! **Where this lives, and why it is in the kit rather than the vault.** The
//! grammar is a property of the statement, not of the file: a seat holding the
//! vault, a seat holding none, and the gateway must all refuse the same shapes,
//! and the refusal is what makes the port's statement-as-data checkable at
//! every one of those ends. What the vault owns is the half that needs the
//! file: which physical tables are entities, what each caller's access decision
//! is, which columns are sealed. That half enters here as [`TableFacts`] and
//! [`check_columns`] — the door's splice point, and the only thing lane D1 has
//! to hand over.
//!
//! **The grammar refuses by construction, not by scanning.** [`parse`] returns
//! a `StatementShape` or an error; there is no path that returns a shape for a
//! statement the grammar rejected, so a caller cannot forget to check.

use std::collections::BTreeSet;

use crate::error::{KitError, KitResult};
use crate::statement::PageQuery;

/// Words a statement may use that are not column references. Deliberately
/// short: every addition is a new thing the grammar has to be sure of, and the
/// handlers that exist need none of the rest of SQL
/// (`paged-door.ts:64-104`, verbatim and in v0's order).
pub const ALLOWED_WORDS: [&str; 34] = [
    "and",
    "or",
    "not",
    "is",
    "null",
    "in",
    "between",
    "like",
    "case",
    "when",
    "then",
    "else",
    "end",
    "as",
    "coalesce",
    "cast",
    "text",
    "integer",
    "real",
    "distinct",
    "count",
    "min",
    "max",
    "sum",
    "abs",
    "length",
    "substr",
    "lower",
    "upper",
    "ifnull",
    "nullif",
    "json_extract",
    "true",
    "false",
];

/// Punctuation and operators the grammar accepts, longest first
/// (`paged-door.ts:106-124`).
pub const OPERATORS: [&str; 16] = [
    "<=", ">=", "<>", "!=", "||", "=", "<", ">", "+", "-", "*", "/", "(", ")", ",", "?",
];

fn is_allowed_word(lower: &str) -> bool {
    ALLOWED_WORDS.contains(&lower)
}

fn is_ident(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|char| char.is_ascii_alphanumeric() || char == '_')
}

/// One table a statement names, as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FromPart {
    pub physical: String,
    /// The alias the statement refers to it by; the physical name when none.
    pub alias: String,
}

/// One column reference, and which part of the statement made it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnRef {
    /// `SELECT`, `WHERE` or `ON` — the label the refusal quotes.
    pub label: &'static str,
    /// As written, qualified or not.
    pub text: String,
}

/// A statement the grammar accepted, taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementShape {
    pub tables: Vec<FromPart>,
    /// Every `ON` condition, in join order. Each goes through the same checks
    /// as the `where`: it is a predicate over the same columns, so it gets the
    /// same grammar and the same field mask (`paged-door.ts:185-191`).
    pub join_conditions: Vec<String>,
    pub refs: Vec<ColumnRef>,
}

/// What the vault knows about one of the statement's tables, and the only thing
/// the door needs from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableFacts {
    pub alias: String,
    pub physical: String,
    /// The logical `schema.table` the access decision was taken on.
    pub entity: String,
    pub columns: BTreeSet<String>,
    /// `None` is the owner: every column. `Some` is the R17 field mask.
    pub field_mask: Option<Vec<String>>,
    /// Never projectable: a page is a read, and plaintext takes `reveal`.
    pub sealed: Vec<String>,
}

/// Split one text part into tokens, refusing anything the grammar has no token
/// for. A comment, a semicolon or a string containing either is a refusal here,
/// before any table has been resolved — the cheapest place to say no.
fn tokenize(name: &str, part: &str, label: &str) -> KitResult<Vec<String>> {
    if part.contains(';') || part.contains("--") || part.contains("/*") {
        return Err(KitError::refuse(
            name,
            format!("{label} contains a comment or a statement separator"),
        ));
    }
    let bytes = part.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let char = bytes[index];
        if char.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if char == b'\'' {
            let Some(offset) = part[index + 1..].find('\'') else {
                return Err(KitError::refuse(
                    name,
                    format!("{label} has an unterminated string"),
                ));
            };
            let close = index + 1 + offset;
            tokens.push(part[index..=close].to_owned());
            index = close + 1;
            continue;
        }
        if char.is_ascii_digit() {
            let mut end = index;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end < bytes.len()
                && bytes[end] == b'.'
                && bytes.get(end + 1).is_some_and(u8::is_ascii_digit)
            {
                end += 1;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
            }
            tokens.push(part[index..end].to_owned());
            index = end;
            continue;
        }
        if char.is_ascii_alphabetic() || char == b'_' {
            let mut end = word_end(bytes, index);
            if bytes.get(end) == Some(&b'.')
                && bytes
                    .get(end + 1)
                    .is_some_and(|next| next.is_ascii_alphabetic() || *next == b'_')
            {
                end = word_end(bytes, end + 1);
            }
            tokens.push(part[index..end].to_owned());
            index = end;
            continue;
        }
        let Some(operator) = OPERATORS
            .iter()
            .find(|operator| part[index..].starts_with(**operator))
        else {
            return Err(KitError::refuse(
                name,
                format!(
                    "{label} contains \"{}\", which the door's grammar has no token for",
                    char::from(char)
                ),
            ));
        };
        tokens.push((*operator).to_owned());
        index += operator.len();
    }
    Ok(tokens)
}

fn word_end(bytes: &[u8], from: usize) -> usize {
    let mut end = from;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    end
}

/// Split a FROM on the JOIN keyword, keeping the join kind out of the way: the
/// door treats every join the same, because the access decision does not depend
/// on whether a missing row becomes NULL or removes the pair
/// (`paged-door.ts:211-214`).
fn split_joins(from: &str) -> Vec<String> {
    let lower = from.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut segments = Vec::new();
    let mut start = 0usize;
    let mut cursor = 0usize;
    while let Some(offset) = lower.get(cursor..).and_then(|rest| rest.find("join")) {
        let at = cursor + offset;
        let end = at + "join".len();
        let framed = at > 0
            && bytes[at - 1].is_ascii_whitespace()
            && bytes.get(end).is_some_and(u8::is_ascii_whitespace);
        if !framed {
            cursor = at + 1;
            continue;
        }
        let mut separator_start = back_over_whitespace(bytes, at);
        let word_start = back_over_word(bytes, separator_start);
        let kind = &lower[word_start..separator_start];
        if matches!(kind, "left" | "inner" | "cross") && word_start > 0 {
            separator_start = back_over_whitespace(bytes, word_start);
        }
        let mut separator_end = end;
        while bytes
            .get(separator_end)
            .is_some_and(u8::is_ascii_whitespace)
        {
            separator_end += 1;
        }
        segments.push(from[start..separator_start].to_owned());
        start = separator_end;
        cursor = separator_end;
    }
    segments.push(from[start..].to_owned());
    segments
}

fn back_over_whitespace(bytes: &[u8], from: usize) -> usize {
    let mut at = from;
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    at
}

fn back_over_word(bytes: &[u8], from: usize) -> usize {
    let mut at = from;
    while at > 0 && !bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    at
}

/// The source and the `ON` condition of one join segment.
fn split_on(segment: &str) -> (String, Option<String>) {
    let lower = segment.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut cursor = 0usize;
    while let Some(offset) = lower.get(cursor..).and_then(|rest| rest.find("on")) {
        let at = cursor + offset;
        let end = at + 2;
        if at > 0
            && bytes[at - 1].is_ascii_whitespace()
            && bytes.get(end).is_some_and(u8::is_ascii_whitespace)
        {
            let source_end = back_over_whitespace(bytes, at);
            let mut condition_start = end;
            while bytes
                .get(condition_start)
                .is_some_and(u8::is_ascii_whitespace)
            {
                condition_start += 1;
            }
            return (
                segment[..source_end].to_owned(),
                Some(segment[condition_start..].to_owned()),
            );
        }
        cursor = at + 1;
    }
    (segment.to_owned(), None)
}

/// The FROM clause, as tables and equijoins:
/// `table [AS alias] [ [LEFT|INNER|CROSS] JOIN table [AS alias] ON <cond> ]*`.
fn parse_from(name: &str, from: &str) -> KitResult<(Vec<FromPart>, Vec<String>)> {
    if from.contains(';') || from.contains("--") || from.contains("/*") {
        return Err(KitError::refuse(
            name,
            "FROM contains a comment or a statement separator",
        ));
    }
    if from.contains('(') {
        return Err(KitError::refuse(
            name,
            "FROM contains a subquery; the door runs statements over tables it can name",
        ));
    }
    let mut parts = Vec::new();
    let mut conditions = Vec::new();
    for (position, segment) in split_joins(from).into_iter().enumerate() {
        let (source, condition) = if position == 0 {
            (segment, None)
        } else {
            split_on(&segment)
        };
        if position > 0 {
            match condition {
                Some(condition) if !condition.trim().is_empty() => conditions.push(condition),
                _ => return Err(KitError::refuse(name, "a JOIN in FROM has no ON condition")),
            }
        }
        let words: Vec<&str> = source.split_whitespace().collect();
        let Some(table) = words.first().copied().filter(|table| is_ident(table)) else {
            return Err(KitError::refuse(
                name,
                format!("FROM names \"{}\", which is not a table", source.trim()),
            ));
        };
        let rest = &words[1..];
        let alias = match rest {
            [] => table.to_owned(),
            [alias] if is_ident(alias) => (*alias).to_owned(),
            [keyword, alias] if keyword.eq_ignore_ascii_case("as") && is_ident(alias) => {
                (*alias).to_owned()
            }
            _ => {
                return Err(KitError::refuse(
                    name,
                    format!("FROM has an alias the door cannot read: {}", source.trim()),
                ));
            }
        };
        parts.push(FromPart {
            physical: table.to_owned(),
            alias,
        });
    }
    Ok((parts, conditions))
}

/// Every column reference a text part makes, as written.
///
/// A word that is not in [`ALLOWED_WORDS`], is not a literal and is not followed
/// by `(` is a column. A word the list does not name that IS followed by `(` is
/// an unknown function, which is a refusal rather than a column: SQLite has
/// functions that read files (`paged-door.ts:265-272`).
fn column_refs(name: &str, tokens: &[String], label: &'static str) -> KitResult<Vec<ColumnRef>> {
    let mut refs = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if OPERATORS.contains(&token.as_str()) {
            continue;
        }
        if token.starts_with('\'') || token.starts_with(|char: char| char.is_ascii_digit()) {
            continue;
        }
        let lower = token.to_ascii_lowercase();
        let is_call = tokens.get(index + 1).is_some_and(|next| next == "(");
        if is_call {
            if !is_allowed_word(&lower) {
                return Err(KitError::refuse(
                    name,
                    format!("{label} calls {token}, which is not on the door's list"),
                ));
            }
            continue;
        }
        if is_allowed_word(&lower) && !token.contains('.') {
            continue;
        }
        refs.push(ColumnRef {
            label,
            text: token.clone(),
        });
    }
    Ok(refs)
}

/// Take one statement apart, or refuse it.
///
/// This is the whole of the grammar half: after it returns, every table the
/// statement names is known by alias, every `ON` condition has been tokenized
/// under the same rules as the `where`, and every column reference has been
/// collected with the part that made it. Nothing here needs the vault file.
pub fn parse(query: &PageQuery) -> KitResult<StatementShape> {
    let name = query.name.as_str();
    let (tables, join_conditions) = parse_from(name, &query.from)?;
    if tables.is_empty() {
        return Err(KitError::refuse(name, "FROM names no table"));
    }
    let aliases: BTreeSet<&str> = tables.iter().map(|table| table.alias.as_str()).collect();
    if aliases.len() != tables.len() {
        return Err(KitError::refuse(
            name,
            "two tables in FROM answer to the same name",
        ));
    }

    let mut refs = Vec::new();
    let mut parts: Vec<(&'static str, &str)> = vec![
        ("SELECT", query.select.as_str()),
        ("WHERE", query.r#where.as_deref().unwrap_or("")),
    ];
    for condition in &join_conditions {
        parts.push(("ON", condition.as_str()));
    }
    for (label, part) in parts {
        if part.trim().is_empty() {
            continue;
        }
        let tokens = tokenize(name, part, label)?;
        if tokens
            .iter()
            .any(|token| token.eq_ignore_ascii_case("select"))
        {
            return Err(KitError::refuse(
                name,
                format!("{label} contains a nested SELECT"),
            ));
        }
        refs.extend(column_refs(name, &tokens, label)?);
    }
    Ok(StatementShape {
        tables,
        join_conditions,
        refs,
    })
}

/// Resolve every column reference to its table and check the field mask.
///
/// An unqualified column on a multi-table statement is **refused rather than
/// guessed**: two tables with a `title` each would make the guess wrong exactly
/// where it matters, and a handler that says which one it means costs one word
/// (`paged-door.ts:294-300`).
pub fn check_columns(
    query_name: &str,
    shape: &StatementShape,
    facts: &[TableFacts],
) -> KitResult<()> {
    for reference in &shape.refs {
        check_column(query_name, reference, facts)?;
    }
    Ok(())
}

fn check_column(name: &str, reference: &ColumnRef, facts: &[TableFacts]) -> KitResult<()> {
    let label = reference.label;
    let text = reference.text.as_str();
    if let Some(dot) = text.find('.').filter(|dot| *dot > 0) {
        let alias = &text[..dot];
        let column = &text[dot + 1..];
        let Some(table) = facts.iter().find(|table| table.alias == alias) else {
            return Err(KitError::refuse(
                name,
                format!("{label} reads {text}, but the statement has no {alias}"),
            ));
        };
        if !table.columns.contains(column) {
            return Err(KitError::refuse(
                name,
                format!("{label} reads {text}, which {} has not got", table.physical),
            ));
        }
        return check_visibility(name, label, text, column, table);
    }
    let owners: Vec<&TableFacts> = facts
        .iter()
        .filter(|table| table.columns.contains(text))
        .collect();
    match owners.as_slice() {
        [] => Err(KitError::refuse(
            name,
            format!("{label} reads {text}, which no table in the statement has"),
        )),
        [owner] => check_visibility(name, label, text, text, owner),
        _ => Err(KitError::refuse(
            name,
            format!("{label} reads {text} unqualified and more than one table has it"),
        )),
    }
}

fn check_visibility(
    name: &str,
    label: &str,
    text: &str,
    column: &str,
    table: &TableFacts,
) -> KitResult<()> {
    if let Some(mask) = table.field_mask.as_ref()
        && !mask.iter().any(|allowed| allowed == column)
    {
        return Err(KitError::refuse(
            name,
            format!("{label} reads {text}, which this caller's field mask does not carry"),
        ));
    }
    if table.sealed.iter().any(|sealed| sealed == column) {
        return Err(KitError::refuse(
            name,
            format!("{label} reads {text}, which is sealed; plaintext takes reveal"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statement::PageOrder;

    fn query(select: &str, from: &str, r#where: Option<&str>) -> PageQuery {
        let mut query = PageQuery::new(
            "kit.grammar",
            select,
            from,
            PageOrder::asc("expense_id", "expense_id"),
        );
        query.r#where = r#where.map(str::to_owned);
        query
    }

    fn facts() -> Vec<TableFacts> {
        vec![
            TableFacts {
                alias: "e".to_owned(),
                physical: "tally_expense".to_owned(),
                entity: "tally.expense".to_owned(),
                columns: ["expense_id", "group_id", "amount_minor", "deleted_at"]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                field_mask: None,
                sealed: Vec::new(),
            },
            TableFacts {
                alias: "s".to_owned(),
                physical: "tally_expense_split".to_owned(),
                entity: "tally.expense_split".to_owned(),
                columns: ["expense_id", "party_id", "share_minor"]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                field_mask: None,
                sealed: Vec::new(),
            },
        ]
    }

    #[test]
    fn a_join_with_an_alias_and_an_on_condition_is_taken_apart() {
        let shape = parse(&query(
            "e.expense_id, s.party_id",
            "tally_expense e LEFT JOIN tally_expense_split AS s ON s.expense_id = e.expense_id",
            Some("e.deleted_at IS NULL"),
        ))
        .unwrap();
        assert_eq!(
            shape.tables,
            vec![
                FromPart {
                    physical: "tally_expense".to_owned(),
                    alias: "e".to_owned()
                },
                FromPart {
                    physical: "tally_expense_split".to_owned(),
                    alias: "s".to_owned()
                },
            ]
        );
        assert_eq!(shape.join_conditions.len(), 1);
        check_columns("kit.grammar", &shape, &facts()).unwrap();
    }

    // ---- the corpus of refused shapes; each one is a demonstrated red ----

    #[test]
    fn refused_shapes() {
        let cases: Vec<(&str, PageQuery)> = vec![
            (
                "a second statement",
                query("expense_id", "tally_expense", Some("1 = 1; DROP TABLE x")),
            ),
            (
                "a comment",
                query("expense_id", "tally_expense", Some("1 = 1 -- and more")),
            ),
            (
                "a block comment",
                query("expense_id /* hi */", "tally_expense", None),
            ),
            (
                "a subquery in FROM",
                query("expense_id", "(SELECT 1) t", None),
            ),
            (
                "a nested SELECT in WHERE",
                query(
                    "expense_id",
                    "tally_expense",
                    Some("expense_id IN ( SELECT expense_id )"),
                ),
            ),
            (
                "an unlisted function",
                query("readfile ( expense_id )", "tally_expense", None),
            ),
            (
                "a JOIN with no ON",
                query(
                    "e.expense_id",
                    "tally_expense e JOIN tally_expense_split s",
                    None,
                ),
            ),
            (
                "an unterminated string",
                query("expense_id", "tally_expense", Some("group_id = 'oops")),
            ),
            (
                "a token the grammar has no shape for",
                query("expense_id", "tally_expense", Some("group_id @> 'x'")),
            ),
            (
                "two tables under one name",
                query(
                    "e.expense_id",
                    "tally_expense e JOIN tally_expense_split e ON e.expense_id = e.expense_id",
                    None,
                ),
            ),
            (
                "an alias the door cannot read",
                query("expense_id", "tally_expense the big one", None),
            ),
        ];
        for (why, case) in cases {
            let outcome = parse(&case);
            assert!(
                matches!(outcome, Err(KitError::GrammarRefused { .. })),
                "{why} was not refused: {outcome:?}"
            );
        }
    }

    #[test]
    fn an_unqualified_column_two_tables_have_is_refused() {
        let shape = parse(&query(
            "expense_id",
            "tally_expense e JOIN tally_expense_split s ON s.expense_id = e.expense_id",
            None,
        ))
        .unwrap();
        assert!(matches!(
            check_columns("kit.grammar", &shape, &facts()),
            Err(KitError::GrammarRefused { .. })
        ));
    }

    #[test]
    fn a_column_outside_the_field_mask_and_a_sealed_column_are_both_refused() {
        let shape = parse(&query("e.amount_minor", "tally_expense e", None)).unwrap();
        let mut masked = facts();
        masked[0].field_mask = Some(vec!["expense_id".to_owned()]);
        assert!(matches!(
            check_columns("kit.grammar", &shape, &masked),
            Err(KitError::GrammarRefused { .. })
        ));
        let mut sealed = facts();
        sealed[0].sealed = vec!["amount_minor".to_owned()];
        assert!(matches!(
            check_columns("kit.grammar", &shape, &sealed),
            Err(KitError::GrammarRefused { .. })
        ));
    }

    #[test]
    fn a_listed_function_and_a_literal_are_not_columns() {
        let shape = parse(&query(
            "coalesce ( e.amount_minor , 0 ) , 'x' , 12 , ?",
            "tally_expense e",
            None,
        ))
        .unwrap();
        assert_eq!(
            shape
                .refs
                .iter()
                .map(|reference| reference.text.as_str())
                .collect::<Vec<_>>(),
            vec!["e.amount_minor"]
        );
    }
}
