//! The per-system follow maps (`SYSTEMS`) and their defaults/shape callbacks.
//!
//! UNPLUGGED (#1214, checkpoint 1, `crates/vault/UNPLUGGED.md`): every system's map belongs to the
//! app lane that owns its kind (a map names the kind's columns, its children and its homes, all of
//! which moved), so the table is empty until each lane re-plugs its own. The engine in `merge.rs`
//! and `commands.rs` is the kernel's and stays; the removed maps are in this file's history at
//! `40b18d2c`.

use serde_json::Value as Json;

use super::merge::same;
use super::{Child, SystemMap};

/// The name a system gives a record: `stated.title`, kept in a column of its own so a read of it
/// parses no JSON.
pub(super) fn stated_title(stated: &Json) -> Option<&str> {
    stated.get("title").and_then(Json::as_str)
}

impl SystemMap {
    /// Whether a record of this system may state `name`.
    pub(super) fn states(&self, name: &str) -> bool {
        name == "title" || self.fields.contains(&name) || self.child(name).is_some()
    }

    pub(super) fn child(&self, name: &str) -> Option<&Child> {
        self.children.iter().find(|child| child.name == name)
    }

    /// Whether two values of the field say the same thing.
    pub(crate) fn agree(&self, name: &str, left: Option<&Json>, right: Option<&Json>) -> bool {
        match self.child(name) {
            Some(child) => same(
                left.map(child.canon).as_ref(),
                right.map(child.canon).as_ref(),
            ),
            None => same(left, right),
        }
    }
}

/// The systems the vault follows: none plugged in yet (see the module comment).
pub const SYSTEMS: &[SystemMap] = &[];
