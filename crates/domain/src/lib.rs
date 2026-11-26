//! THE APP PLANE'S DECLARATIONS.
//!
//! [`KINDS`], [`ACTIONS`] and [`READS`] are the one catalogue the assistant's tool
//! vocabulary is generated from (`crates/assist/build.rs`). They are empty until the
//! new app plane declares its kinds, its actions and its reads; the generator and
//! everything downstream already read them as data.
//!
//! The rest is the vault read door the assistant and the search index share: a
//! keyset page, a row, the statement grammar and the money law.

pub mod actions;
pub mod civil;
pub mod denial;
pub mod error;
pub mod grammar;
pub mod manifest;
pub mod money;
pub mod page;
pub mod reads;
pub mod row;
pub mod spelling;
pub mod statement;
pub mod testdoor;

pub use denial::{Denial, Reading, denial_of};
pub use error::{KitError, KitResult};
pub use page::{MAX_PAGE_ROWS, Page, PageCursor, PageRequest, page_of, probe_limit};
pub use reads::{
    FanOutBound, JOIN_FAN_OUT, PageDoor, Window, in_list, read_by_id, read_page, read_pages,
    read_window,
};
pub use row::{Cell, Row};
pub use statement::{
    PageBindValue, PageOrder, PageQuery, page_cursor_boundary, page_cursor_of, page_statement,
};

/// A table and a column: where a value is read from.
pub type Source = (&'static str, &'static str);

/// One model-facing field of a kind.
#[derive(Debug, Clone, Copy)]
pub struct FieldDecl {
    pub name: &'static str,
    pub kind: &'static str,
    pub source: Source,
    pub unit: Option<&'static str>,
    pub values: &'static [(&'static str, &'static str)],
}

/// A link from one kind to another, and the vault relation it travels.
#[derive(Debug, Clone, Copy)]
pub struct LinkDecl {
    pub kind: &'static str,
    pub label: &'static str,
    pub via: &'static str,
}

/// A kind the assistant can name: a person, a task, a note.
#[derive(Debug, Clone, Copy)]
pub struct KindDecl {
    pub app: &'static str,
    pub id: &'static str,
    pub name: &'static str,
    pub plural: &'static str,
    pub entity: &'static str,
    pub table: &'static str,
    pub pk: &'static str,
    pub name_source: Source,
    pub date: Option<(&'static str, Source)>,
    pub fields: &'static [FieldDecl],
    pub links: &'static [LinkDecl],
    pub trash: bool,
    pub container: bool,
    pub writable: bool,
    /// The full-text domain whose hits are this kind's rows, when the kind is searchable.
    pub search: Option<&'static str>,
}

/// An action chat runs on its own: `(verb, kind, qualifier)` and the vault command behind it.
#[derive(Debug, Clone, Copy)]
pub struct ActionDecl {
    pub app: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub verb: &'static str,
    pub also: &'static [&'static str],
    pub kind: &'static str,
    pub qualifier: Option<&'static str>,
    pub id_param: &'static str,
    pub inverse: Option<&'static str>,
    pub properties: &'static [&'static str],
    pub required: &'static [&'static str],
    pub aliases: &'static [(&'static str, &'static [&'static str])],
    pub consts: &'static [(&'static str, &'static str)],
    pub defaults: &'static [(&'static str, &'static str)],
    pub minted: &'static [&'static str],
}

/// A named read: its shape, its statement and the tables it reads.
#[derive(Debug, Clone, Copy)]
pub struct ReadDecl {
    pub name: &'static str,
    pub shape: &'static str,
    pub sql: &'static str,
    pub tables: &'static [&'static str],
}

pub const KINDS: &[KindDecl] = &[];
pub const ACTIONS: &[ActionDecl] = &[];
pub const READS: &[ReadDecl] = &[];
