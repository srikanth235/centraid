//! THE READ CONTEXT (app-plane §2): the tables a room's loads read. A commit publishes the tables
//! it wrote; every open room whose context intersects them reloads.

use std::collections::BTreeSet;

use super::ReadDecl;

/// The union of `reads ∪ across` of every read a room has run.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReadContext {
    tables: BTreeSet<&'static str>,
}

impl ReadContext {
    /// A context holding nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that `read` ran.
    pub fn record(&mut self, read: &ReadDecl) {
        self.tables.extend(read.tables());
    }

    /// Whether a commit that wrote `written` reaches this room.
    #[must_use]
    pub fn intersects<'a>(&self, written: impl IntoIterator<Item = &'a str>) -> bool {
        written.into_iter().any(|table| self.tables.contains(table))
    }

    /// The tables, in name order.
    pub fn tables(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.tables.iter().copied()
    }
}
