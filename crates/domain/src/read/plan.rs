//! THE PLAN GATE (app-plane §2): each read passes `EXPLAIN QUERY PLAN` at test time, and a plan
//! outside its shape fails. The only exceptions are rows of the query-plan allowlist
//! (`contracts/ledgers/query-plans.json`), a count that only shrinks.

use rusqlite::Connection;

use super::{MAX_PAGE, ReadDecl, Shape};

/// One line of `EXPLAIN QUERY PLAN`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub id: i64,
    pub parent: i64,
    pub detail: String,
}

/// What a plan did that its shape forbids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finding {
    /// A full scan of a table or an index. Allowlistable.
    Scan(String),
    /// A temp B-tree for an `ORDER BY`, a `GROUP BY`, a `DISTINCT` or a compound. Allowlistable.
    TempBTree(String),
    /// A rule of the shape. Never allowlisted.
    Shape(String),
}

impl Finding {
    /// Whether an allowlist row can excuse it.
    #[must_use]
    pub const fn allowlistable(&self) -> bool {
        matches!(self, Self::Scan(_) | Self::TempBTree(_))
    }
}

impl std::fmt::Display for Finding {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Scan(text) => write!(out, "full scan: {text}"),
            Self::TempBTree(text) => write!(out, "temp B-tree: {text}"),
            Self::Shape(text) => write!(out, "{text}"),
        }
    }
}

/// The plan of `sql`, bound by `bind`.
///
/// # Errors
/// What SQLite refuses.
pub fn explain(
    connection: &Connection,
    sql: &str,
    bind: impl FnOnce(&mut rusqlite::Statement<'_>) -> rusqlite::Result<()>,
) -> rusqlite::Result<Vec<Line>> {
    let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    bind(&mut statement)?;
    let mut rows = statement.raw_query();
    let mut lines = Vec::new();
    while let Some(row) = rows.next()? {
        lines.push(Line {
            id: row.get(0)?,
            parent: row.get(1)?,
            detail: row.get(3)?,
        });
    }
    Ok(lines)
}

/// The first word of a plan line's target: `entity` in `SEARCH entity AS e USING INDEX …`.
fn target(detail: &str) -> &str {
    detail.split_whitespace().nth(1).unwrap_or_default()
}

fn is_search(detail: &str) -> bool {
    detail.starts_with("SEARCH ")
}

fn is_scan(detail: &str) -> bool {
    detail.starts_with("SCAN ")
        && !matches!(target(detail), "CONSTANT" | "")
        && !target(detail).starts_with('(')
}

/// The terms a `SEARCH` constrains: `a=? AND b>?` in `… USING INDEX i (a=? AND b>?)`.
fn terms(detail: &str) -> Vec<&str> {
    let Some(open) = detail.rfind(" (") else {
        return Vec::new();
    };
    detail[open + 2..]
        .trim_end_matches(')')
        .split(" AND ")
        .collect()
}

/// The index a `SEARCH` uses, if it names one.
fn index_of(detail: &str) -> Option<&str> {
    let after = detail.split(" USING ").nth(1)?;
    let after = after
        .strip_prefix("COVERING INDEX ")
        .or_else(|| after.strip_prefix("INDEX "))?;
    after.split_whitespace().next()
}

/// Whether a `SEARCH` pins one row: equality on the whole of a unique key.
fn pins_one_row(connection: &Connection, detail: &str) -> rusqlite::Result<bool> {
    let table = target(detail);
    let equal = terms(detail);
    if !equal.iter().all(|term| term.ends_with("=?")) {
        return Ok(false);
    }
    if detail.contains("USING INTEGER PRIMARY KEY") {
        return Ok(true);
    }
    if detail.contains("USING PRIMARY KEY") {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let keys = statement
            .query_map([], |row| row.get::<_, i64>(5))?
            .filter_map(Result::ok)
            .filter(|position| *position > 0)
            .count();
        return Ok(keys == equal.len());
    }
    let Some(index) = index_of(detail) else {
        return Ok(false);
    };
    let unique = {
        let mut statement = connection.prepare(&format!("PRAGMA index_list({table})"))?;
        let rows: Vec<(String, bool)> = statement
            .query_map([], |row| Ok((row.get(1)?, row.get::<_, i64>(2)? == 1)))?
            .filter_map(Result::ok)
            .collect();
        rows.iter().any(|(name, unique)| name == index && *unique)
    };
    let columns = connection
        .prepare(&format!("PRAGMA index_info({index})"))?
        .query_map([], |row| row.get::<_, String>(2))?
        .count();
    Ok(unique && columns == equal.len())
}

/// The constant `LIMIT` the statement ends with, if it is one.
fn constant_limit(sql: &str) -> Option<usize> {
    let upper = sql.to_ascii_uppercase();
    let at = upper.rfind("LIMIT")?;
    sql[at + 5..]
        .trim()
        .trim_end_matches(';')
        .trim()
        .parse()
        .ok()
}

/// What `plan` does that `read`'s shape forbids.
///
/// # Errors
/// What SQLite refuses while the gate inspects an index.
pub fn findings(
    connection: &Connection,
    read: &ReadDecl,
    plan: &[Line],
) -> rusqlite::Result<Vec<Finding>> {
    let mut found = Vec::new();
    for line in plan {
        if is_scan(&line.detail) {
            found.push(Finding::Scan(line.detail.clone()));
        }
        if line.detail.contains("TEMP B-TREE") {
            found.push(Finding::TempBTree(line.detail.clone()));
        }
    }
    let searches: Vec<&Line> = plan.iter().filter(|line| is_search(&line.detail)).collect();
    let shape = |text: String| Finding::Shape(format!("{:?}: {text}", read.shape));
    match read.shape {
        Shape::ByKey => {
            if searches.is_empty() {
                found.push(shape("no SEARCH by a key".to_owned()));
            }
            for line in searches {
                if !pins_one_row(connection, &line.detail)? {
                    found.push(shape(format!(
                        "`{}` is not an equality on the whole of a unique key",
                        line.detail
                    )));
                }
            }
        }
        Shape::BoundedChild => {
            if read.bound == 0 || read.bound > MAX_PAGE {
                found.push(shape(format!(
                    "bound {} is not 1 to {MAX_PAGE}",
                    read.bound
                )));
            }
            match constant_limit(read.sql) {
                Some(limit) if limit <= read.bound => {}
                other => found.push(shape(format!(
                    "wants a constant LIMIT of at most its bound {}, found {other:?}",
                    read.bound
                ))),
            }
            if !searches.first().is_some_and(|line| {
                terms(&line.detail)
                    .first()
                    .is_some_and(|t| t.ends_with("=?"))
            }) {
                found.push(shape(
                    "the first SEARCH does not lead with the parent's equality".to_owned(),
                ));
            }
        }
        Shape::Aggregate => {
            let lower = read.sql.to_ascii_lowercase();
            if !["count(", "sum(", "min(", "max("]
                .iter()
                .any(|call| lower.contains(call))
            {
                found.push(shape("takes no COUNT, SUM, MIN or MAX".to_owned()));
            }
            if read.bound == 0 {
                found.push(shape("declares no bound".to_owned()));
            }
        }
        Shape::PagedList => {
            if read.bound == 0 || read.bound > MAX_PAGE {
                found.push(shape(format!(
                    "page size {} is not 1 to {MAX_PAGE}",
                    read.bound
                )));
            }
            if read.cursor.is_empty() {
                found.push(shape("has no cursor".to_owned()));
            }
            if !read.sql.to_ascii_uppercase().contains("LIMIT :N") {
                found.push(shape("does not end in LIMIT :n".to_owned()));
            }
            for key in read.cursor {
                if !read.sql.contains(&format!(":{}", key.param)) {
                    found.push(shape(format!(
                        "its keyset predicate does not bind `:{}`",
                        key.param
                    )));
                }
            }
        }
    }
    Ok(found)
}

/// The query-plan allowlist (`contracts/ledgers/query-plans.json`): the reads allowed a scan or a
/// temp B-tree, each with its home and its reason, and a count that only shrinks.
#[derive(Debug, Clone, Default)]
pub struct Allowlist {
    /// The count the ledger states.
    pub allowed: usize,
    /// The reads it names.
    pub homes: Vec<String>,
}

impl Allowlist {
    /// The `pages` rows of the ledger under `root`.
    ///
    /// # Errors
    /// A ledger that cannot be read, or is not the shape this expects.
    pub fn load(root: &std::path::Path) -> Result<Self, String> {
        let path = root.join("contracts/ledgers/query-plans.json");
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let ledger: serde_json::Value =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        let pages = &ledger["pages"];
        let allowed = pages["allowed"]
            .as_u64()
            .and_then(|count| usize::try_from(count).ok())
            .ok_or("pages.allowed is not a count")?;
        let homes = pages["entries"]
            .as_array()
            .ok_or("pages.entries is not a list")?
            .iter()
            .map(|entry| {
                let home = entry["home"].as_str().ok_or("an entry has no home")?;
                entry["reason"]
                    .as_str()
                    .filter(|reason| !reason.trim().is_empty())
                    .ok_or_else(|| format!("{home} has no reason"))?;
                Ok(home.to_owned())
            })
            .collect::<Result<_, String>>()?;
        Ok(Self { allowed, homes })
    }

    /// Whether `read` is excused a scan or a temp B-tree.
    #[must_use]
    pub fn excuses(&self, read: &str) -> bool {
        self.homes.iter().any(|home| home == read)
    }
}
