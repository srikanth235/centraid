//! `copy/<app>.json` — the emitted sentences, and the route-id claim.
//!
//! A copy leaf in v0 is a module of named strings, import-free where both the
//! shell and the mobile kit read it. `contracts/tools/export-copy.ts` emits one
//! `copy/<app>.json` per app from those leaves, and this module loads one.
//!
//! **No formatting logic lives here.** A leaf's `export function` sentences —
//! `routeStatus`, `moreMeta` — are decisions about how a sentence is composed
//! and are listed in the file's `functions` array rather than emitted; what
//! crosses is text, looked up, never a `switch` (census §A0).
//!
//! ## The claim worth testing (#1020, D-1020-T5)
//!
//! A route id that exists in the copy table and not on the screen — or on the
//! screen and not in the copy table — is a **silent empty string**: the surface
//! renders nothing and no test notices. So the emitter commits BOTH sets, read
//! independently from the copy leaf and from the app's shelf table, and
//! [`route_gaps`] compares them.

use std::collections::{BTreeMap, BTreeSet};

/// One app's emitted copy.
#[derive(Debug, Clone, Default)]
pub struct CopyLeaf {
    pub app: String,
    /// Name → sentence. A lookup, never a `switch`.
    pub strings: BTreeMap<String, String>,
    /// What did NOT cross: the leaf's functions and computed consts.
    pub functions: Vec<String>,
    /// The route ids the copy table keys its ambient sentences on.
    pub routes: BTreeSet<String>,
    /// The route ids reachable from the band's More sheet.
    pub more_routes: BTreeSet<String>,
    /// The screen's own route ids, from the shelf table.
    pub shelves: Vec<Shelf>,
}

/// One routed shelf: the route id, its label and its URL segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shelf {
    pub id: String,
    pub label: String,
    pub segment: String,
}

impl CopyLeaf {
    /// A sentence by name, or `None`.
    ///
    /// `None` rather than `""`: an absent sentence is a missing translation and
    /// a surface has to be able to tell it from a deliberately empty one.
    #[must_use]
    pub fn text(&self, name: &str) -> Option<&str> {
        self.strings.get(name).map(String::as_str)
    }

    /// Read a parsed `copy/<app>.json`.
    #[must_use]
    pub fn from_json(value: &serde_json::Value) -> Self {
        let strings = value
            .get("strings")
            .and_then(serde_json::Value::as_object)
            .map(|entries| {
                entries
                    .iter()
                    .map(|(name, text)| {
                        (name.clone(), text.as_str().unwrap_or_default().to_owned())
                    })
                    .collect()
            })
            .unwrap_or_default();
        let list = |at: &str| -> Vec<String> {
            value
                .get(at)
                .and_then(serde_json::Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| entry.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            app: value
                .get("app")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            strings,
            functions: list("functions"),
            routes: list("routes").into_iter().collect(),
            more_routes: list("moreRoutes").into_iter().collect(),
            shelves: value
                .get("shelves")
                .and_then(serde_json::Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| Shelf {
                            id: entry["id"].as_str().unwrap_or_default().to_owned(),
                            label: entry["label"].as_str().unwrap_or_default().to_owned(),
                            segment: entry["segment"].as_str().unwrap_or_default().to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// The two directions a route id can be missing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RouteGaps {
    /// On the screen, with no sentence: the silent empty string.
    pub without_copy: BTreeSet<String>,
    /// In the copy table, reaching no screen — a sentence nobody can read, and
    /// the shape a deleted route leaves behind.
    pub without_screen: BTreeSet<String>,
}

impl RouteGaps {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.without_copy.is_empty() && self.without_screen.is_empty()
    }
}

/// Compare the copy table's route ids with the screen's, ignoring the named
/// variants a caller knows about.
///
/// `allowed_variants` is for ids that are a SECOND sentence for one route
/// rather than a route of their own — Tally's `groupOwn` is the group ledger's
/// other sentence (`route-copy.ts:34`) — and for the states a route can be in
/// (`denied`). Naming them at the call site keeps the exception in the test
/// that knows why, instead of in this function.
#[must_use]
pub fn route_gaps(leaf: &CopyLeaf, allowed_variants: &[&str]) -> RouteGaps {
    let screen: BTreeSet<&str> = leaf.shelves.iter().map(|shelf| shelf.id.as_str()).collect();
    RouteGaps {
        without_copy: screen
            .iter()
            .filter(|id| !leaf.routes.contains(**id))
            .map(|id| (*id).to_owned())
            .collect(),
        without_screen: leaf
            .routes
            .iter()
            .filter(|id| !screen.contains(id.as_str()))
            .filter(|id| !allowed_variants.contains(&id.as_str()))
            .cloned()
            .collect(),
    }
}
