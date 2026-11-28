//! THE READ REGISTRY (app-plane §2, M1).
//!
//! A read is a `const` declaration: a name, one of four shapes, one read-only statement, its typed
//! parameters, the tables it reads and the tables of other modules it joins. Everything that
//! checks it lives beside it: the SQLite authorizer ([`authorizer`]), the plan gate ([`plan`]),
//! the keyset cursor ([`cursor`]), the door that runs it ([`door`]) and the context a screen
//! reloads on ([`context`]).

pub mod authorizer;
pub mod context;
pub mod cursor;
pub mod door;
pub mod error;
pub mod plan;

pub use context::ReadContext;
pub use door::{Answer, Args, Reader};
pub use error::{ReadError, STALE_LIST};

/// What a read returns and what its plan must look like (app-plane §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// One row by a unique or primary key, equality on the whole key.
    ByKey,
    /// The rows of one parent, newest first, a constant `LIMIT`.
    BoundedChild,
    /// `COUNT`, `SUM`, `MIN` or `MAX`, optionally grouped by a schema-bounded key.
    Aggregate,
    /// A total order ending in a unique column, a keyset predicate and `LIMIT :n`.
    PagedList,
}

/// The type a parameter is bound as. A civil day is a `Day`, never an instant: the zone is the
/// caller's and a parameter of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamTy {
    /// A row's id.
    Id,
    /// A word of a closed list (a kind, a relation) or free text.
    Text,
    /// A civil day, `YYYY-MM-DD`.
    Day,
    /// A whole number.
    Int,
}

/// One named parameter of a read's statement, written `:name`.
#[derive(Debug, Clone, Copy)]
pub struct Param {
    pub name: &'static str,
    pub ty: ParamTy,
}

/// A parameter named `name`, of type `ty`.
#[must_use]
pub const fn param(name: &'static str, ty: ParamTy) -> Param {
    Param { name, ty }
}

/// One term of a page's `ORDER BY` tuple: the result column the cursor reads it from, the
/// parameter the statement's keyset predicate takes it as, and whether the order runs upward.
#[derive(Debug, Clone, Copy)]
pub struct Key {
    pub column: &'static str,
    pub param: &'static str,
    pub ascending: bool,
}

/// A descending key: `column` is bound as `:param` on the next page.
#[must_use]
pub const fn desc(column: &'static str, param: &'static str) -> Key {
    Key {
        column,
        param,
        ascending: false,
    }
}

#[must_use]
pub const fn asc(column: &'static str, param: &'static str) -> Key {
    Key {
        column,
        param,
        ascending: true,
    }
}

/// The most rows a page may hold.
pub const MAX_PAGE: usize = 200;
/// The page size a list declares unless it says otherwise.
pub const DEFAULT_PAGE: usize = 50;
/// The most rows a reload re-reads of the pages a list had already loaded.
pub const RELOAD_CAP: usize = 500;

/// A read as the registry holds it: everything but the row type.
#[derive(Debug, Clone, Copy)]
pub struct ReadDecl {
    /// `<module>.<read>`; unique.
    pub name: &'static str,
    pub shape: Shape,
    /// One read-only statement. All joins, filters, sums and counts run in SQLite, before `LIMIT`.
    pub sql: &'static str,
    pub params: &'static [Param],
    /// The tables this read reads. The authorizer records the tables a prepared statement
    /// touches, and the declaration must equal `reads ∪ across`.
    pub reads: &'static [&'static str],
    /// Tables of other modules this read joins, listed apart.
    pub across: &'static [&'static str],
    /// `BoundedChild`, `Aggregate`: the most rows it may return. `PagedList`: the page size.
    pub bound: usize,
    /// `PagedList`: the `ORDER BY` tuple, last term a unique column. Empty otherwise.
    pub cursor: &'static [Key],
}

impl ReadDecl {
    /// Every table the statement may touch.
    pub fn tables(&self) -> impl Iterator<Item = &'static str> {
        self.reads.iter().chain(self.across.iter()).copied()
    }
}

/// A read and the typed row it returns: a struct, never a map of values.
pub struct Read<R: 'static> {
    pub decl: ReadDecl,
    pub row: fn(&rusqlite::Row<'_>) -> rusqlite::Result<R>,
}

/// A read from its declaration and the function that decodes one row.
#[must_use]
pub const fn read<R>(
    decl: ReadDecl,
    row: fn(&rusqlite::Row<'_>) -> rusqlite::Result<R>,
) -> Read<R> {
    Read { decl, row }
}
