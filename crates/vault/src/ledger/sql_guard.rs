//! The `vault_sql` grammar: one read-only statement, and nothing else (#1020,
//! D-1020-AS2).
//!
//! ## What this is for
//!
//! `vault_sql` is the **owner's** whole-model surface: a question a member asks
//! about their own vault in their own words, lowered to one SQL statement by a
//! harness. It is the single widest door in the product, so its grammar is the
//! narrowest thing in this crate.
//!
//! Three layers, in order, and each one alone would be insufficient:
//!
//! 1. **Shape.** The statement must be a `SELECT`, a `WITH … SELECT`, or an
//!    `EXPLAIN`, it must be exactly ONE statement, and it must name no
//!    machinery band. A parser is used rather than a keyword scan because
//!    `SELECT` is also a prefix of a comment-hidden `DELETE`.
//! 2. **Principal.** The runner is owner-credentialed
//!    (`vault-sql-tool.ts:1`–`:8`). An agent-scoped turn is refused here, not
//!    filtered afterwards — which is the corpus's `read-confinement` payloads.
//! 3. **The connection.** [`crate::Vault::read`] sets `PRAGMA query_only = ON`
//!    for the duration. So even a statement that got past layers one and two
//!    cannot write, because SQLite itself refuses it. This is the layer that
//!    makes the other two a defence rather than the defence.
//!
//! Plus a row cap, because a `SELECT *` over a large table is a memory
//! exhaustion the member did not ask for.
//!
//! ## Why the guard is here rather than in `crates/assist`
//!
//! The guard is not a statement, but it is the *grammar of statements*, and
//! `sql-confinement` puts that in `crates/vault` with the rest of the SQL. The
//! alternative — a checker in `crates/assist` — would be a second place that
//! knows which tables are machinery, and the two lists would drift on the day a
//! band is added. `crates/assist::mcp` calls [`check`] and holds no table
//! names at all.
//!
//! Comparisons are case-insensitive over lowercase spellings, because a harness
//! writes whatever case it likes and `Select` must be read as `select`.

/// The most rows one `vault_sql` answer may carry.
pub const MAX_ROWS: usize = 500;

/// The longest statement accepted, in bytes. A statement longer than this is
/// not a question, it is a payload.
pub const MAX_STATEMENT_BYTES: usize = 8_000;

/// Bands a `vault_sql` statement may never name, whatever the principal.
///
/// The `ledger` band is on this list and that is the point: **none of the
/// assistant's own transcript is reachable from the tool the assistant is
/// holding** (`ledger.ts:1`–`:20`). An assistant that could read
/// `conversation_provider_consent` could read which providers it is allowed to
/// talk to, and an assistant that could read `items` could read another
/// conversation's turns.
pub const FORBIDDEN_PREFIXES: [&str; 8] = [
    "access_", "agent_", "audit_", "blob_", "enrich_", "outbox_", "replica_", "sync_",
];

/// Tables in the `ledger` band, which carry no prefix of their own.
pub const FORBIDDEN_TABLES: [&str; 15] = [
    "conversations",
    "turns",
    "items",
    "attachments",
    "conversation_harness_sessions",
    "conversation_turn_locks",
    "conversation_workspace_selection",
    "harness_health",
    "conversation_provider_consent",
    "automation_state",
    "automation_trigger_cursor",
    "trigger_ingress",
    "conversation_archive",
    "conversation_digest",
    "run_summary",
];

/// Why a statement was refused. Each variant is a sentence the harness can
/// show, because a refusal a model cannot understand is a refusal it retries.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("vault_sql is the owner's surface; this turn runs as `{principal}`")]
    NotOwner { principal: String },
    #[error("vault_sql takes one statement; this is {count}")]
    NotOneStatement { count: usize },
    #[error(
        "vault_sql reads: a statement must start with select, with … select, or explain — this \
         one starts with `{found}`"
    )]
    NotReadOnly { found: String },
    #[error("`{table}` is gateway machinery and is not readable through vault_sql")]
    ForbiddenTable { table: String },
    #[error("this statement is {bytes} bytes; the limit is {MAX_STATEMENT_BYTES}")]
    TooLong { bytes: usize },
    #[error("vault_sql takes a statement, and this is empty")]
    Empty,
}

/// A statement that has passed the grammar. Constructed only by [`check`], so
/// a caller cannot hand a raw string to a runner by accident.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked(String);

impl Checked {
    #[must_use]
    pub fn statement(&self) -> &str {
        &self.0
    }
}

/// Whether the principal running this turn may use `vault_sql` at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    /// An owner device, or an agent riding an acting owner with no clamp that
    /// narrows the whole model.
    Owner,
    /// Anything else: an agent with a schema grant, a read-only device, a
    /// share. The corpus's `exfil-sql` payloads all arrive here.
    Scoped { name: &'static str },
}

/// Check one statement.
pub fn check(sql: &str, caller: Caller) -> Result<Checked, Refusal> {
    if let Caller::Scoped { name } = caller {
        // FIRST, and before any parsing. A refusal that depended on the shape
        // of the statement would be a refusal an attacker can probe.
        return Err(Refusal::NotOwner {
            principal: name.to_owned(),
        });
    }
    if sql.len() > MAX_STATEMENT_BYTES {
        return Err(Refusal::TooLong { bytes: sql.len() });
    }
    let stripped = strip_comments(sql);
    let statements = split_statements(&stripped);
    match statements.len() {
        0 => return Err(Refusal::Empty),
        1 => {}
        count => return Err(Refusal::NotOneStatement { count }),
    }
    let body = statements[0].trim();
    let first = body
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let first: String = first
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    if !matches!(first.as_str(), "select" | "with" | "explain") {
        return Err(Refusal::NotReadOnly { found: first });
    }
    for word in identifiers(body) {
        if FORBIDDEN_TABLES.contains(&word.as_str())
            || FORBIDDEN_PREFIXES
                .iter()
                .any(|prefix| word.starts_with(prefix))
        {
            return Err(Refusal::ForbiddenTable { table: word });
        }
    }
    Ok(Checked(body.to_owned()))
}

/// Run a checked statement and collect up to `max_rows` rows.
///
/// Goes through [`crate::Vault::read`], which sets `PRAGMA query_only = ON` for
/// the duration. That is the layer that makes [`check`] a defence rather than
/// *the* defence: a statement that somehow got past the grammar still cannot
/// write, because SQLite itself refuses it.
///
/// One row past the cap is fetched on purpose, so the answer can say whether it
/// was truncated rather than leaving the reader to guess from a round number.
pub fn run_checked(
    vault: &crate::Vault,
    checked: &Checked,
    max_rows: usize,
) -> crate::Result<(Vec<String>, Vec<Vec<serde_json::Value>>, bool)> {
    vault.read(|connection| {
        let mut statement = connection
            .prepare(checked.statement())
            .map_err(|error| crate::VaultError::from_sqlite("preparing a vault_sql read", error))?;
        let columns: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let width = columns.len();
        let mut rows = Vec::new();
        let mut query = statement
            .query([])
            .map_err(|error| crate::VaultError::from_sqlite("running a vault_sql read", error))?;
        let mut truncated = false;
        while let Some(row) = query
            .next()
            .map_err(|error| crate::VaultError::from_sqlite("reading a vault_sql row", error))?
        {
            if rows.len() == max_rows {
                truncated = true;
                break;
            }
            let mut values = Vec::with_capacity(width);
            for index in 0..width {
                let value = row.get_ref(index).map_err(|error| {
                    crate::VaultError::from_sqlite("reading a vault_sql value", error)
                })?;
                values.push(match value {
                    rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                    rusqlite::types::ValueRef::Integer(number) => serde_json::json!(number),
                    rusqlite::types::ValueRef::Real(number) => serde_json::json!(number),
                    rusqlite::types::ValueRef::Text(bytes) => {
                        serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned())
                    }
                    // A blob is NOT stringified: an answer that turned image
                    // bytes into mojibake would be a wrong answer that looks
                    // like a right one. Its size is the honest report.
                    rusqlite::types::ValueRef::Blob(bytes) => {
                        serde_json::json!({ "blobBytes": bytes.len() })
                    }
                });
            }
            rows.push(values);
        }
        Ok((columns, rows, truncated))
    })
}

/// Remove `--` line comments and `/* */` blocks, respecting string literals.
///
/// Comments are stripped before the shape check because
/// `/*select*/ delete from core_party` starts with `select` to a naive reader
/// and is a delete to SQLite.
fn strip_comments(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut at = 0usize;
    while at < chars.len() {
        let current = chars[at];
        if current == '\'' || current == '"' {
            let quote = current;
            out.push(current);
            at += 1;
            while at < chars.len() {
                out.push(chars[at]);
                if chars[at] == quote {
                    // A doubled quote is an escaped quote, not a close.
                    if at + 1 < chars.len() && chars[at + 1] == quote {
                        out.push(chars[at + 1]);
                        at += 2;
                        continue;
                    }
                    at += 1;
                    break;
                }
                at += 1;
            }
            continue;
        }
        if current == '-' && chars.get(at + 1) == Some(&'-') {
            while at < chars.len() && chars[at] != '\n' {
                at += 1;
            }
            out.push(' ');
            continue;
        }
        if current == '/' && chars.get(at + 1) == Some(&'*') {
            at += 2;
            while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                at += 1;
            }
            at = (at + 2).min(chars.len());
            out.push(' ');
            continue;
        }
        out.push(current);
        at += 1;
    }
    out
}

/// Split on top-level `;`, dropping empties. A trailing semicolon is fine — it
/// is how every SQL console in the world ends a statement — but a second
/// statement after it is not.
fn split_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut found = Vec::new();
    let mut current = String::new();
    let mut at = 0usize;
    while at < chars.len() {
        let character = chars[at];
        if character == '\'' || character == '"' {
            let quote = character;
            current.push(character);
            at += 1;
            while at < chars.len() {
                current.push(chars[at]);
                if chars[at] == quote {
                    if at + 1 < chars.len() && chars[at + 1] == quote {
                        current.push(chars[at + 1]);
                        at += 2;
                        continue;
                    }
                    at += 1;
                    break;
                }
                at += 1;
            }
            continue;
        }
        if character == ';' {
            if !current.trim().is_empty() {
                found.push(current.clone());
            }
            current.clear();
            at += 1;
            continue;
        }
        current.push(character);
        at += 1;
    }
    if !current.trim().is_empty() {
        found.push(current);
    }
    found
}

/// Every bare identifier in the statement, lowercased, with string literals
/// excluded.
///
/// Deliberately over-broad: it returns column names and keywords too. A column
/// called `items` would be refused, and that is the right trade — the cost is a
/// rephrased question, and the cost of the other direction is a readable
/// transcript.
fn identifiers(sql: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut current = String::new();
    let mut in_string: Option<char> = None;
    for character in sql.chars() {
        if let Some(quote) = in_string {
            if character == quote {
                in_string = None;
            }
            continue;
        }
        if character == '\'' || character == '"' {
            in_string = Some(character);
            continue;
        }
        if character.is_ascii_alphanumeric() || character == '_' {
            current.push(character.to_ascii_lowercase());
            continue;
        }
        if !current.is_empty() {
            found.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        found.push(current);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: Caller = Caller::Owner;
    const AGENT: Caller = Caller::Scoped { name: "assistant" };

    fn refuse(sql: &str) -> Refusal {
        check(sql, OWNER).expect_err("must be refused")
    }

    #[test]
    fn an_owner_read_passes() {
        let checked = check("select display_name from core_party limit 5", OWNER)
            .expect("a plain owner read");
        assert!(checked.statement().starts_with("select"));
        assert!(check("WITH x AS (select 1) select * from x", OWNER).is_ok());
        assert!(check("EXPLAIN select 1", OWNER).is_ok());
        assert!(
            check("select 1;", OWNER).is_ok(),
            "a trailing semicolon is how a console ends a statement"
        );
    }

    #[test]
    fn an_agent_scoped_turn_is_refused_before_the_statement_is_read() {
        // The corpus's `commons-11-exfil-sql` and `ics-04-exfil-sql`.
        let error = check("select * from core_content_item", AGENT)
            .expect_err("whole-model sql is the owner's");
        assert_eq!(
            error,
            Refusal::NotOwner {
                principal: "assistant".to_owned()
            }
        );
        // Even a syntactically invalid statement gets the same answer: the
        // refusal must not leak whether the statement would have parsed.
        assert_eq!(
            check("not even sql", AGENT),
            Err(Refusal::NotOwner {
                principal: "assistant".to_owned()
            })
        );
    }

    #[test]
    fn a_write_is_refused_however_it_is_dressed() {
        assert!(matches!(
            refuse("delete from core_party"),
            Refusal::NotReadOnly { .. }
        ));
        assert!(matches!(
            refuse("/*select*/ delete from core_party"),
            Refusal::NotReadOnly { .. }
        ));
        assert!(matches!(
            refuse("--select\ndrop table core_party"),
            Refusal::NotReadOnly { .. }
        ));
        assert!(matches!(
            refuse("pragma writable_schema=1"),
            Refusal::NotReadOnly { .. }
        ));
    }

    #[test]
    fn a_second_statement_is_refused_even_after_a_legal_first() {
        assert_eq!(
            refuse("select 1; delete from core_party"),
            Refusal::NotOneStatement { count: 2 }
        );
    }

    #[test]
    fn the_ledger_band_is_not_readable_through_the_tool_it_records() {
        for table in [
            "items",
            "turns",
            "conversations",
            "conversation_provider_consent",
        ] {
            let error = refuse(&format!("select * from {table}"));
            assert!(
                matches!(error, Refusal::ForbiddenTable { .. }),
                "{table} must not be readable: {error}"
            );
        }
        assert!(matches!(
            refuse("select * from access_receipt"),
            Refusal::ForbiddenTable { .. }
        ));
        assert!(matches!(
            refuse("select * from sync_connection"),
            Refusal::ForbiddenTable { .. }
        ));
    }

    #[test]
    fn a_forbidden_name_inside_a_string_literal_is_not_a_table() {
        // A member asking about a party literally called "items" is asking a
        // question, not reaching for the band.
        assert!(
            check(
                "select 1 from core_party where display_name = 'items'",
                OWNER
            )
            .is_ok()
        );
    }

    #[test]
    fn a_statement_longer_than_a_question_is_refused() {
        let long = format!("select '{}'", "x".repeat(MAX_STATEMENT_BYTES));
        assert!(matches!(refuse(&long), Refusal::TooLong { .. }));
    }

    #[test]
    fn an_empty_statement_says_so() {
        assert_eq!(refuse("   \n -- nothing \n "), Refusal::Empty);
    }

    #[test]
    fn a_quoted_semicolon_does_not_split_the_statement() {
        assert!(
            check("select 1 from core_party where display_name = 'a;b'", OWNER).is_ok(),
            "a semicolon inside a literal is data"
        );
    }
}
