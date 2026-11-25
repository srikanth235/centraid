//! The per-system follow maps (`SYSTEMS`) and their defaults/shape callbacks.
//!
//! **Registering a system's map is one step: a row in [`SYSTEMS`].** The command (`follow.<…>`),
//! its schema and its preconditions are built from the rows; the engine in `merge.rs` reads what a
//! system fills, whether it retires, whether it names a device and which kinds it yields from
//! `origin_system` and `source_shape`, so a map says only which fields its kind has and how a
//! record reads.
//!
//! The table is empty until each app lane re-plugs its own map (a map names the kind's columns,
//! its children and its defaults, all of which moved with the v0 schema); the removed maps are in
//! this file's history at `40b18d2c` and the engine is proved with maps of the tests' own
//! (`tests/follow_*.rs`).

use serde_json::{Map, Value as Json};

use super::merge::same;
use super::{Child, Maps, SystemMap};

/// The name a system gives a record: `stated.title`, kept in a column of its own so a read of it
/// parses no JSON.
pub(super) fn stated_title(stated: &Json) -> Option<&str> {
    stated.get("title").and_then(Json::as_str)
}

/// Put the instants a record states, the fields named, in the clock's one form whatever the phone
/// spelled, so what the row holds and what the source stated stay equal: the helper a map's
/// `shape` calls for each field it holds as an instant.
pub fn canonical_instants(fields: &mut Map<String, Json>, names: &[&str]) {
    for name in names {
        if let Some(Json::String(text)) = fields.get_mut(*name) {
            *text = crate::time::temporal::canonical(text);
        }
    }
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

/// The maps the vault follows: none plugged in yet (see the module comment).
pub const SYSTEMS: &[SystemMap] = &[];

/// The product's maps, [`SYSTEMS`], as the type the follow commands are built from.
pub struct Systems;

impl Maps for Systems {
    const MAPS: &'static [SystemMap] = SYSTEMS;
}
