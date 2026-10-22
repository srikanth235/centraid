//! WHAT A STATEMENT WILL DO, ASKED OF SQLITE (#1135).
//!
//! A read that is fast over a few hundred rows and a table scan over a year-3
//! vault is the regression a timing test finds only after it has shipped and the
//! corpus has grown. SQLite will say, before a statement runs, how it intends to
//! run it (`EXPLAIN QUERY PLAN`), and this module is the vault's half of asking:
//! it plans a statement against the open vault, counts the rows of each table, and
//! reads what the plan says. The sweep that decides what to plan and what to
//! allow is `crates/core/tests/query_plans.rs`; it holds no SQL (`sql-confinement`
//! keeps SQL out of every crate but this one, the kit, search and ontology), so
//! everything it needs to say in SQL is said here.
//!
//! **Three things are asked.**
//!
//! 1. [`Vault::tap_pages`] / [`Vault::take_tapped_pages`]: while tapped, the
//!    vault keeps the composed statement and binds of every page read
//!    ([`Vault::keyset_page`] and [`Vault::page_raw`] both end in one choke
//!    point). That is how "every `PageQuery` the apps' loaders hold" is reached
//!    **as the vault composes it**: an app's spec is data, it becomes SQL only
//!    here, and a plan of the spec's text would be a plan of something that never
//!    runs.
//! 2. [`Vault::explain_query_plan`]: the plan of a statement, one line per step,
//!    with any parameter the caller did not bind bound to `NULL` (the plan of
//!    `x = ?` does not depend on the value; the statistics, not the bind, choose
//!    the index).
//! 3. [`statements_in_source`]: the `SELECT`s and `WITH`s a source file writes as
//!    string literals, for the statements that are hand-written rather than
//!    composed.
//!
//! **What is a finding.** [`full_scans`] names a step that reads a whole table
//! (`SCAN <table>` with no index) of a table over a row floor; [`sorts_after_read`]
//! says a step sorts the rows it read (`USE TEMP B-TREE FOR ORDER BY`), which on a
//! paged read means the page cannot stop at its limit. A scan the index makes
//! (`SCAN t USING INDEX ...`) streams in order and stops at `LIMIT`; that is the
//! plan a page wants, and it is not a finding.

use std::collections::{BTreeMap, BTreeSet};

use crate::error::Result;
use crate::file::Vault;
use crate::page::RawPage;
use crate::value::Value;

/// A page read the tap kept: the spec's name (`(raw)` for a statement a caller
/// composed) and the statement the vault composed from it, with its binds.
#[derive(Debug, Clone)]
pub struct TappedPage {
    pub name: String,
    pub page: RawPage,
}

impl Vault {
    /// Start keeping the statement of every page read, until
    /// [`Self::take_tapped_pages`]. A second call starts over.
    ///
    /// **A measurement hook, for the plan sweep and nothing else.** It is read-only (it
    /// keeps the text and binds of statements that run anyway and changes no read's
    /// answer), and it is not reachable from `crates/core-ffi`: the shell's
    /// surface is `Handle::call`, and `with_vault`, the only way to a [`Vault`], is
    /// used there by its tests and fixture binaries, never exported.
    pub fn tap_pages(&self) {
        *self.page_tap.borrow_mut() = Some(Vec::new());
    }

    /// The page reads since [`Self::tap_pages`], and stop keeping them.
    pub fn take_tapped_pages(&self) -> Vec<TappedPage> {
        self.page_tap.borrow_mut().take().unwrap_or_default()
    }

    /// Keep a page read, if a test is tapping.
    pub(crate) fn tapped(&self, name: &str, page: &RawPage) {
        if let Some(tap) = self.page_tap.borrow_mut().as_mut() {
            tap.push(TappedPage {
                name: name.to_owned(),
                page: page.clone(),
            });
        }
    }

    /// The plan SQLite chooses for `sql`, one line of `detail` per step.
    ///
    /// A parameter the caller left unbound is bound to `NULL`.
    ///
    /// # Errors
    /// SQLite's refusal to prepare the statement (an unknown table, a fragment).
    pub fn explain_query_plan(&self, sql: &str, binds: &[Value]) -> Result<Vec<String>> {
        self.read(|connection| {
            let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let wanted = statement.parameter_count();
            let mut values: Vec<Value> = binds.to_vec();
            values.resize(wanted.max(binds.len()), Value::Null);
            let params: Vec<&dyn rusqlite::ToSql> = values
                .iter()
                .take(wanted)
                .map(|value| value as &dyn rusqlite::ToSql)
                .collect();
            let mut rows = statement.query(params.as_slice())?;
            let mut plan = Vec::new();
            while let Some(row) = rows.next()? {
                plan.push(row.get::<_, String>("detail")?);
            }
            Ok(plan)
        })
    }

    /// How many rows each ordinary table holds, by name.
    ///
    /// # Errors
    /// Whatever SQLite refused.
    pub fn table_rows(&self) -> Result<BTreeMap<String, i64>> {
        self.read(|connection| {
            let names = connection
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table'
                        AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'
                        AND name NOT IN ('search_config', 'search_data', 'search_docsize', 'search_idx')",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut rows = BTreeMap::new();
            for name in names {
                let count: i64 = connection.query_row(
                    &format!("SELECT count(*) FROM {}", crate::log::quoted(&name)),
                    [],
                    |row| row.get(0),
                )?;
                rows.insert(name, count);
            }
            Ok(rows)
        })
    }
}

/// The tables a plan reads whole: a `SCAN <table>` step with no index, of a table
/// in `big`. A scan of a virtual table (`SCAN search VIRTUAL TABLE INDEX ...`),
/// of a subquery or of a constant row names no table in `big` and is not one.
///
/// **`sql` is asked too, for the aliases.** The plan names a table by the alias
/// the statement gave it (`SCAN e`), so the statement's own `FROM` and `JOIN`
/// clauses say which table that is. An alias two subqueries spend on different
/// tables is every table it names, which can only over-report.
#[must_use]
pub fn full_scans(plan: &[String], sql: &str, big: &BTreeSet<String>) -> Vec<String> {
    let aliases = aliases_of(sql);
    let mut scanned = Vec::new();
    for step in plan {
        let Some(rest) = step.strip_prefix("SCAN ") else {
            continue;
        };
        if rest.contains(" USING ") || rest.contains("VIRTUAL TABLE") {
            continue;
        }
        let Some(name) = rest.split_whitespace().next() else {
            continue;
        };
        let tables: BTreeSet<String> = match aliases.get(name) {
            Some(tables) => tables.clone(),
            None => BTreeSet::from([name.to_owned()]),
        };
        scanned.extend(tables.into_iter().filter(|table| big.contains(table)));
    }
    scanned
}

/// Whether a plan reads any table in `big`, by a scan or by a search that is not
/// a single-row lookup. A sort of the rows of a table of a few dozen is not the
/// sort this module is afraid of: the cost of `USE TEMP B-TREE FOR ORDER BY` is
/// the rows it sorts. A search by primary key or by a unique constraint
/// (`SEARCH e USING INDEX sqlite_autoindex_entity_1 (id=?)`) fetches the one row
/// a join asked for and adds nothing to what is sorted.
#[must_use]
pub fn reads_big_table(plan: &[String], sql: &str, big: &BTreeSet<String>) -> bool {
    let aliases = aliases_of(sql);
    plan.iter().any(|step| {
        let Some(rest) = step
            .strip_prefix("SCAN ")
            .or_else(|| step.strip_prefix("SEARCH "))
        else {
            return false;
        };
        let point_lookup = step.starts_with("SEARCH ")
            && (rest.contains("USING PRIMARY KEY")
                || rest.contains("USING INTEGER PRIMARY KEY")
                || rest.contains("sqlite_autoindex_"));
        if rest.contains("VIRTUAL TABLE") || point_lookup {
            return false;
        }
        let Some(name) = rest.split_whitespace().next() else {
            return false;
        };
        match aliases.get(name) {
            Some(tables) => tables.iter().any(|table| big.contains(table)),
            None => big.contains(name),
        }
    })
}

/// What each name a statement gives a table in its `FROM` and `JOIN` clauses
/// stands for: `entity AS e` and `entity e` both say `e` is `entity`.
fn aliases_of(sql: &str) -> BTreeMap<String, BTreeSet<String>> {
    const NOT_AN_ALIAS: [&str; 20] = [
        "WHERE",
        "ON",
        "JOIN",
        "LEFT",
        "RIGHT",
        "INNER",
        "CROSS",
        "OUTER",
        "NATURAL",
        "ORDER",
        "GROUP",
        "LIMIT",
        "USING",
        "UNION",
        "HAVING",
        "WINDOW",
        "INDEXED",
        "NOT",
        "EXCEPT",
        "INTERSECT",
    ];
    let words: Vec<String> = sql
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '"'))
        .filter(|word| !word.is_empty())
        .map(|word| word.trim_matches('"').to_owned())
        .collect();
    let mut aliases: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for at in 0..words.len() {
        if !(words[at].eq_ignore_ascii_case("from") || words[at].eq_ignore_ascii_case("join")) {
            continue;
        }
        let Some(table) = words.get(at + 1) else {
            continue;
        };
        let alias = match words.get(at + 2) {
            Some(next) if next.eq_ignore_ascii_case("as") => words.get(at + 3),
            Some(next)
                if !NOT_AN_ALIAS
                    .iter()
                    .any(|keyword| next.eq_ignore_ascii_case(keyword))
                    && !next.eq_ignore_ascii_case("from") =>
            {
                Some(next)
            }
            _ => None,
        };
        if let Some(alias) = alias {
            aliases
                .entry(alias.clone())
                .or_default()
                .insert(table.clone());
        }
    }
    aliases
}

/// Whether a plan sorts the rows it read before it can return the first one.
#[must_use]
pub fn sorts_after_read(plan: &[String]) -> bool {
    plan.iter()
        .any(|step| step.contains("USE TEMP B-TREE FOR ORDER BY"))
}

/// A string literal of a source file that reads like a read statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStatement {
    /// The line the literal opens on, from 1.
    pub line: usize,
    /// The literal's text, escapes resolved.
    pub sql: String,
}

impl SourceStatement {
    /// Whether the text has a hole a `format!` fills: its plan is a plan of a
    /// fragment and cannot be asked.
    #[must_use]
    pub fn is_dynamic(&self) -> bool {
        self.sql.contains('{')
    }

    /// The statement on one line, whitespace collapsed: what the allowlist names.
    #[must_use]
    pub fn normalized(&self) -> String {
        self.sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}

/// The `SELECT` and `WITH` statements written as string literals in `source`.
///
/// A literal counts when its first word is `SELECT` or `WITH` (any case). Comments
/// and character literals are skipped, raw strings and escapes are read; a
/// `concat!` or a `format!` that joins literals is not followed, which is why
/// [`SourceStatement::is_dynamic`] exists and why the statements a composer builds
/// are reached through [`Vault::tap_pages`] instead.
#[must_use]
pub fn statements_in_source(source: &str) -> Vec<SourceStatement> {
    let chars: Vec<char> = source.chars().collect();
    let mut found = Vec::new();
    let mut line = 1usize;
    let mut at = 0usize;
    while at < chars.len() {
        let c = chars[at];
        match c {
            '\n' => {
                line += 1;
                at += 1;
            }
            '/' if chars.get(at + 1) == Some(&'/') => {
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
            }
            '/' if chars.get(at + 1) == Some(&'*') => {
                at += 2;
                while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                    if chars[at] == '\n' {
                        line += 1;
                    }
                    at += 1;
                }
                at += 2;
            }
            '\'' => {
                // A character literal (`'"'`, `'\''`, `'x'`) or a lifetime.
                if chars.get(at + 1) == Some(&'\\') {
                    at += 2;
                    while at < chars.len() && chars[at] != '\'' {
                        at += 1;
                    }
                    at += 1;
                } else if chars.get(at + 2) == Some(&'\'') {
                    at += 3;
                } else {
                    at += 1;
                }
            }
            'r' if is_raw_start(&chars, at) => {
                let opened = line;
                let mut hashes = 0;
                let mut cursor = at + 1;
                while chars.get(cursor) == Some(&'#') {
                    hashes += 1;
                    cursor += 1;
                }
                cursor += 1; // the opening quote
                let start = cursor;
                loop {
                    if cursor >= chars.len() {
                        break;
                    }
                    if chars[cursor] == '"'
                        && (0..hashes).all(|offset| chars.get(cursor + 1 + offset) == Some(&'#'))
                    {
                        break;
                    }
                    cursor += 1;
                }
                let text: String = chars[start..cursor.min(chars.len())].iter().collect();
                line += text.matches('\n').count();
                keep(&mut found, opened, text);
                at = cursor + 1 + hashes;
            }
            '"' => {
                let opened = line;
                let mut text = String::new();
                let mut cursor = at + 1;
                while cursor < chars.len() && chars[cursor] != '"' {
                    if chars[cursor] == '\\' {
                        cursor += 1;
                        match chars.get(cursor) {
                            Some('n') => text.push('\n'),
                            Some('t') => text.push('\t'),
                            Some('r') => text.push('\r'),
                            Some('0') => text.push('\0'),
                            Some('\n') => {
                                // A line continuation eats the newline and the
                                // indent that follows it.
                                line += 1;
                                while chars
                                    .get(cursor + 1)
                                    .is_some_and(|next| next.is_whitespace())
                                {
                                    cursor += 1;
                                    if chars[cursor] == '\n' {
                                        line += 1;
                                    }
                                }
                            }
                            Some(other) => text.push(*other),
                            None => break,
                        }
                    } else {
                        if chars[cursor] == '\n' {
                            line += 1;
                        }
                        text.push(chars[cursor]);
                    }
                    cursor += 1;
                }
                keep(&mut found, opened, text);
                at = cursor + 1;
            }
            _ => at += 1,
        }
    }
    found
}

/// `r"` or `r#"` that starts a raw string and is not the tail of an identifier.
fn is_raw_start(chars: &[char], at: usize) -> bool {
    if at > 0 && (chars[at - 1].is_alphanumeric() || chars[at - 1] == '_') {
        return false;
    }
    let mut cursor = at + 1;
    while chars.get(cursor) == Some(&'#') {
        cursor += 1;
    }
    chars.get(cursor) == Some(&'"')
}

fn keep(found: &mut Vec<SourceStatement>, line: usize, sql: String) {
    let first = sql
        .split(|c: char| !c.is_ascii_alphabetic())
        .find(|word| !word.is_empty())
        .map(str::to_ascii_lowercase);
    if matches!(first.as_deref(), Some("select" | "with")) && sql.trim_start().len() > 7 {
        found.push(SourceStatement { line, sql });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_select_in_a_string_is_found_and_one_in_a_comment_is_not() {
        let source = r##"
            // SELECT 1 FROM comment
            let a = "SELECT id FROM entity WHERE kind = ?1";
            let b = r#"WITH x AS (SELECT 1) SELECT * FROM x"#;
            let c = "not a statement SELECT";
            let d = '"'; let e = "SELECT n FROM entity \
                      ORDER BY n";
        "##;
        let found = statements_in_source(source);
        let texts: Vec<_> = found.iter().map(SourceStatement::normalized).collect();
        assert_eq!(
            texts,
            [
                "SELECT id FROM entity WHERE kind = ?1",
                "WITH x AS (SELECT 1) SELECT * FROM x",
                "SELECT n FROM entity ORDER BY n",
            ]
        );
        assert_eq!(found[0].line, 3);
        assert_eq!(found[1].line, 4);
    }

    #[test]
    fn a_hole_marks_a_statement_dynamic() {
        let found = statements_in_source(r#"let a = "SELECT {cols} FROM entity";"#);
        assert!(found[0].is_dynamic());
    }

    fn founded() -> (std::path::PathBuf, Vault) {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Plans", "Owner").expect("founded");
        (dir, vault)
    }

    #[test]
    fn a_scan_of_a_table_is_a_full_scan_and_an_index_walk_is_not() {
        let (dir, vault) = founded();
        let big: BTreeSet<String> = ["entity".to_owned(), "note".to_owned()].into();
        let scan = vault
            .explain_query_plan("SELECT id FROM entity WHERE version = ?1", &[])
            .expect("it plans");
        assert_eq!(
            full_scans(&scan, "SELECT id FROM entity WHERE version = ?1", &big),
            ["entity"],
            "{scan:?}"
        );
        // An alias is the table's name in the plan or after it; the table is what counts.
        let aliased = vault
            .explain_query_plan("SELECT e.id FROM entity AS e WHERE e.version = ?1", &[])
            .expect("it plans");
        assert_eq!(
            full_scans(
                &aliased,
                "SELECT e.id FROM entity AS e WHERE e.version = ?1",
                &big
            ),
            ["entity"],
            "{aliased:?}"
        );
        let seek = vault
            .explain_query_plan("SELECT id FROM entity WHERE id = ?1", &[])
            .expect("it plans");
        assert!(
            full_scans(&seek, "SELECT id FROM entity WHERE id = ?1", &big).is_empty(),
            "{seek:?}"
        );
        // A walk of the rowid in order prints as a plain `SCAN entity` too: it
        // streams and stops at its limit, which a plan alone cannot tell from a
        // scan that reads every row. That is why a statement the sweep allows
        // says why, and why [`sorts_after_read`] is a separate question.
        let ordered = vault
            .explain_query_plan("SELECT n FROM entity ORDER BY n DESC LIMIT 10", &[])
            .expect("it plans");
        assert_eq!(ordered, ["SCAN entity"], "{ordered:?}");
        assert!(!sorts_after_read(&ordered), "{ordered:?}");
        let sorted = vault
            .explain_query_plan("SELECT id FROM entity ORDER BY title LIMIT 10", &[])
            .expect("it plans");
        assert!(sorts_after_read(&sorted), "{sorted:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_tapped_page_read_keeps_its_statement() {
        let (dir, vault) = founded();
        vault.tap_pages();
        vault
            .page_raw(&RawPage {
                sql: "SELECT id FROM entity LIMIT 5".to_owned(),
                binds: Vec::new(),
                limit: 5,
            })
            .expect("it pages");
        let tapped = vault.take_tapped_pages();
        assert_eq!(tapped.len(), 1);
        assert_eq!(tapped[0].name, "(raw)");
        assert!(vault.take_tapped_pages().is_empty(), "taking stops the tap");
        let counts = vault.table_rows().expect("it counts");
        assert!(counts["entity"] >= 1, "{counts:?}");
        assert!(
            !counts.contains_key("search"),
            "a virtual table is not counted"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
