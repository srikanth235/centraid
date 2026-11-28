//! THE DOOR A READ RUNS THROUGH: one read-only connection to the vault file, the authorizer on it
//! for as long as it lives, and nothing that writes.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use super::authorizer::Policy;
use super::cursor::{self, Term};
use super::error::{ReadError, Result};
use super::plan::{self, Finding, Line};
use super::{ParamTy, RELOAD_CAP, Read, ReadDecl, Shape};

/// A value bound to a parameter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bound {
    Text(String),
    Int(i64),
}

/// The arguments of one read: a value per declared parameter, and for a page the cursor of the
/// one before it.
#[derive(Debug, Clone, Default)]
pub struct Args {
    values: Vec<(&'static str, Bound)>,
    after: Option<String>,
}

impl Args {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A row's id, a closed-list word, or text.
    #[must_use]
    pub fn text(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.values.push((name, Bound::Text(value.into())));
        self
    }

    /// A civil day.
    #[must_use]
    pub fn day(self, name: &'static str, value: impl Into<String>) -> Self {
        self.text(name, value)
    }

    /// A whole number.
    #[must_use]
    pub fn int(mut self, name: &'static str, value: i64) -> Self {
        self.values.push((name, Bound::Int(value)));
        self
    }

    /// The cursor of the page before this one.
    #[must_use]
    pub fn after(mut self, cursor: impl Into<String>) -> Self {
        self.after = Some(cursor.into());
        self
    }
}

/// What a read answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer<R> {
    pub rows: Vec<R>,
    /// The cursor of the next page; absent when the rows ended.
    pub next: Option<String>,
}

/// What the registry's checks found about one read.
#[derive(Debug, Clone)]
pub struct Inspection {
    /// The tables SQLite resolved.
    pub touched: Vec<String>,
    pub plan: Vec<Line>,
    pub findings: Vec<Finding>,
}

enum Mode {
    Policy(Policy),
    InspectSchema,
}

/// A read-only door onto the vault file.
pub struct Reader {
    connection: Connection,
    active: Arc<Mutex<Option<Mode>>>,
}

/// Ends a read's policy when it drops, so a failure cannot leave one installed.
struct Scope<'a>(&'a Mutex<Option<Mode>>);

impl Drop for Scope<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = None;
        }
    }
}

impl Reader {
    /// Open the vault file at `path` for reading only.
    ///
    /// # Errors
    /// What SQLite refuses.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.pragma_update(None, "query_only", "ON")?;
        let active: Arc<Mutex<Option<Mode>>> = Arc::default();
        let hook = Arc::clone(&active);
        connection.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
            let judged = hook.lock().ok().and_then(|slot| {
                slot.as_ref().map(|mode| match mode {
                    Mode::Policy(policy) => policy.judge(context),
                    Mode::InspectSchema => match context.action {
                        rusqlite::hooks::AuthAction::Pragma {
                            pragma_name: "table_info" | "index_list" | "index_info",
                            ..
                        } => rusqlite::hooks::Authorization::Allow,
                        rusqlite::hooks::AuthAction::Select
                        | rusqlite::hooks::AuthAction::Read { .. } => {
                            rusqlite::hooks::Authorization::Allow
                        }
                        _ => rusqlite::hooks::Authorization::Deny,
                    },
                })
            });
            judged.unwrap_or(rusqlite::hooks::Authorization::Deny)
        }))?;
        Ok(Self { connection, active })
    }

    /// The connection, for the registry's own checks.
    #[must_use]
    pub const fn connection(&self) -> &Connection {
        &self.connection
    }

    fn enter(&self, read: &ReadDecl) -> Result<(Scope<'_>, Policy)> {
        let policy = Policy::of(read);
        *self.active.lock().map_err(|_| ReadError::StaleCursor)? =
            Some(Mode::Policy(policy.clone()));
        Ok((Scope(&self.active), policy))
    }

    fn prepare<'c>(&'c self, read: &ReadDecl, policy: &Policy) -> Result<rusqlite::Statement<'c>> {
        let prepared = self.connection.prepare(read.sql);
        let seen = policy.seen();
        if let Some(why) = seen.refusal {
            return Err(ReadError::Refused {
                read: read.name,
                why,
            });
        }
        let statement = prepared?;
        let declared: std::collections::BTreeSet<&str> = read.tables().collect();
        let touched: std::collections::BTreeSet<&str> =
            seen.tables.iter().map(String::as_str).collect();
        if declared != touched {
            return Err(ReadError::Declared {
                read: read.name,
                why: format!("declares {declared:?} and the statement touches {touched:?}"),
            });
        }
        let mut wanted: Vec<String> = read.params.iter().map(|p| p.name.to_owned()).collect();
        if read.shape == Shape::PagedList {
            wanted.extend(read.cursor.iter().map(|key| key.param.to_owned()));
            wanted.push("n".to_owned());
        }
        wanted.sort();
        let mut named: Vec<String> = (1..=statement.parameter_count())
            .filter_map(|at| statement.parameter_name(at))
            .map(|name| name.trim_start_matches(':').to_owned())
            .collect();
        named.sort();
        named.dedup();
        if wanted != named {
            return Err(ReadError::Declared {
                read: read.name,
                why: format!("declares parameters {wanted:?} and the statement takes {named:?}"),
            });
        }
        Ok(statement)
    }

    /// Prepare `read` under the authorizer, plan it and gate the plan. For the registry's tests.
    ///
    /// # Errors
    /// A refusal of the authorizer, a declaration the statement contradicts, or SQLite's own.
    pub fn inspect(&self, read: &ReadDecl) -> Result<Inspection> {
        let (scope, policy) = self.enter(read)?;
        drop(self.prepare(read, &policy)?);
        let touched = policy.seen().tables.into_iter().collect();
        let plan = plan::explain(&self.connection, read.sql, |statement| {
            for at in 1..=statement.parameter_count() {
                let name = statement.parameter_name(at).unwrap_or_default().to_owned();
                let value = placeholder(read, name.trim_start_matches(':'));
                bind(statement, at, &value)?;
            }
            Ok(())
        })?;
        drop(scope);
        *self.active.lock().map_err(|_| ReadError::StaleCursor)? = Some(Mode::InspectSchema);
        let _inspect_scope = Scope(&self.active);
        let findings = plan::findings(&self.connection, read, &plan)?;
        Ok(Inspection {
            touched,
            plan,
            findings,
        })
    }

    /// Run `read`: its rows, and for a `PagedList` the cursor of the next page.
    ///
    /// # Errors
    /// A parameter that is missing or mistyped, a cursor that is not this read's, a refusal of the
    /// authorizer, more rows than the bound, or SQLite's own.
    pub fn run<R>(&self, read: &Read<R>, args: &Args) -> Result<Answer<R>> {
        let n = read.decl.bound;
        self.answer(read, args, args.after.as_deref(), n)
    }

    /// Re-run a `PagedList` after a commit: one statement over the rows already loaded, at most
    /// [`RELOAD_CAP`]; past the cap the tail pages are dropped and `next` is set.
    ///
    /// # Errors
    /// As [`Self::run`].
    pub fn reload<R>(&self, read: &Read<R>, args: &Args, loaded: usize) -> Result<Answer<R>> {
        let n = loaded.clamp(read.decl.bound, RELOAD_CAP);
        self.answer(read, args, None, n)
    }

    fn answer<R>(
        &self,
        read: &Read<R>,
        args: &Args,
        after: Option<&str>,
        n: usize,
    ) -> Result<Answer<R>> {
        let decl = &read.decl;
        let keys = cursor_keys(decl, after)?;
        let (_scope, policy) = self.enter(decl)?;
        let mut statement = self.prepare(decl, &policy)?;
        execute(&mut statement, read, args, keys.as_deref(), n)
    }
}

pub fn run_on<R>(connection: &Connection, read: &Read<R>, args: &Args) -> Result<Answer<R>> {
    let decl = &read.decl;
    let keys = cursor_keys(decl, args.after.as_deref())?;
    let mut statement = connection.prepare(decl.sql)?;
    execute(&mut statement, read, args, keys.as_deref(), decl.bound)
}

fn cursor_keys(decl: &ReadDecl, after: Option<&str>) -> Result<Option<Vec<Term>>> {
    let paged = decl.shape == Shape::PagedList;
    if !paged && after.is_some() {
        return Err(ReadError::Shape {
            read: decl.name,
            shape: decl.shape,
        });
    }
    if paged {
        Ok(Some(match after {
            Some(text) => cursor::decode(decl, text)?,
            None => cursor::first_page(decl),
        }))
    } else {
        Ok(None)
    }
}

fn execute<R>(
    statement: &mut rusqlite::Statement<'_>,
    read: &Read<R>,
    args: &Args,
    keys: Option<&[Term]>,
    n: usize,
) -> Result<Answer<R>> {
    let decl = &read.decl;
    let paged = decl.shape == Shape::PagedList;
    for declared in decl.params {
        let given = args
            .values
            .iter()
            .find(|(name, _)| *name == declared.name)
            .map(|(_, value)| value)
            .ok_or(ReadError::Param {
                read: decl.name,
                name: declared.name.to_owned(),
                why: "is missing",
            })?;
        if !fits(declared.ty, given) {
            return Err(ReadError::Param {
                read: decl.name,
                name: declared.name.to_owned(),
                why: "is not of its declared type",
            });
        }
        if let Some(at) = statement.parameter_index(&format!(":{}", declared.name))? {
            bind(statement, at, given)?;
        }
    }
    if let Some(extra) = args
        .values
        .iter()
        .find(|(name, _)| !decl.params.iter().any(|declared| declared.name == *name))
    {
        return Err(ReadError::Param {
            read: decl.name,
            name: extra.0.to_owned(),
            why: "is not declared",
        });
    }
    let wanted = if paged { n + 1 } else { decl.bound + 1 };
    if let Some(keys) = keys {
        for (key, term) in decl.cursor.iter().zip(keys) {
            if let Some(at) = statement.parameter_index(&format!(":{}", key.param))? {
                bind(statement, at, &Bound::from(term))?;
            }
        }
        if let Some(at) = statement.parameter_index(":n")? {
            bind(
                statement,
                at,
                &Bound::Int(i64::try_from(wanted).unwrap_or(i64::MAX)),
            )?;
        }
    }
    let columns: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let key_at: Vec<usize> = decl
        .cursor
        .iter()
        .map(|key| {
            columns
                .iter()
                .position(|column| column == key.column)
                .ok_or_else(|| ReadError::Declared {
                    read: decl.name,
                    why: format!(
                        "its cursor key `{}` is not a column of the result",
                        key.column
                    ),
                })
        })
        .collect::<Result<_>>()?;
    let mut rows = Vec::new();
    let mut last: Vec<Term> = Vec::new();
    let mut more = false;
    let mut query = statement.raw_query();
    while let Some(row) = query.next()? {
        if rows.len() == if paged { n } else { decl.bound } {
            more = true;
            break;
        }
        rows.push((read.row)(row)?);
        if paged {
            last = key_at
                .iter()
                .map(|at| match row.get_ref(*at)? {
                    ValueRef::Text(text) => {
                        Ok(Term::Text(String::from_utf8_lossy(text).into_owned()))
                    }
                    ValueRef::Integer(number) => Ok(Term::Int(number)),
                    _ => Err(ReadError::Declared {
                        read: decl.name,
                        why: "a cursor key is NULL, and a keyset cannot continue over one"
                            .to_owned(),
                    }),
                })
                .collect::<Result<_>>()?;
        }
    }
    if more && !paged {
        return Err(ReadError::Bound {
            read: decl.name,
            bound: decl.bound,
        });
    }
    let next = if paged && more {
        Some(cursor::encode(decl, &last)?)
    } else {
        None
    };
    Ok(Answer { rows, next })
}

impl From<&Term> for Bound {
    fn from(term: &Term) -> Self {
        match term {
            Term::Text(text) => Self::Text(text.clone()),
            Term::Int(number) => Self::Int(*number),
        }
    }
}

fn bind(statement: &mut rusqlite::Statement<'_>, at: usize, value: &Bound) -> rusqlite::Result<()> {
    match value {
        Bound::Text(text) => statement.raw_bind_parameter(at, text.as_str()),
        Bound::Int(number) => statement.raw_bind_parameter(at, *number),
    }
}

fn fits(ty: ParamTy, value: &Bound) -> bool {
    match (ty, value) {
        (ParamTy::Id, Bound::Text(text)) => !text.is_empty() && !text.contains(char::is_whitespace),
        (ParamTy::Text, Bound::Text(_)) | (ParamTy::Int, Bound::Int(_)) => true,
        (ParamTy::Day, Bound::Text(text)) => is_day(text),
        _ => false,
    }
}

fn is_day(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let [year, month, day] = parts[..] else {
        return false;
    };
    let number = |part: &str, width: usize| {
        (part.len() == width && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse::<u32>().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day)) = (number(year, 4), number(month, 2), number(day, 2))
    else {
        return false;
    };
    let long = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=long).contains(&day)
}

/// A value to plan under: the declared type's, and for a page the first-page sentinel.
fn placeholder(read: &ReadDecl, name: &str) -> Bound {
    if name == "n" {
        return Bound::Int(i64::try_from(read.bound + 1).unwrap_or(1));
    }
    if let Some(key) = read.cursor.iter().position(|key| key.param == name) {
        return Bound::from(&cursor::first_page(read)[key]);
    }
    match read
        .params
        .iter()
        .find(|param| param.name == name)
        .map(|p| p.ty)
    {
        Some(ParamTy::Int) => Bound::Int(1),
        Some(ParamTy::Day) => Bound::Text("2026-01-01".to_owned()),
        Some(ParamTy::Id) => Bound::Text("00000000-0000-7000-8000-000000000000".to_owned()),
        _ => Bound::Text("x".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::is_day;

    #[test]
    fn a_day_is_a_calendar_day() {
        assert!(is_day("2026-02-28") && is_day("2024-02-29"));
        assert!(!is_day("2026-02-29") && !is_day("2026-13-01") && !is_day("2026-1-1"));
        assert!(!is_day("2026-01-01T09:00"));
    }
}
