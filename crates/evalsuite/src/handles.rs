//! STABLE ROW HANDLES — why `suite.json` holds no uuid.
//!
//! The suite's ground truth is a set of row ids, and the ids the world mints
//! are a function of the SEED AND THE COMMAND ORDER. Seeding one extra command
//! anywhere before a row shifts that row's id and every id after it — so
//! growing the world used to rewrite the corpus, and a corpus that is rewritten
//! by hand is a corpus whose meaning drifts. Two lanes lost a day to exactly
//! that before this module existed. **The fragility was a harness defect, not a
//! fact of life.**
//!
//! So a case names a row the way a member would: `agenda/dentist-cleaning`.
//! The handle is declared once, at the top of `suite.json`, as the row's
//! IDENTIFYING FACTS — its app, its logical entity and the label the inventory
//! carries — and [`Suite::resolve`] turns each one into the id the world minted
//! this build, before any scoring happens.
//!
//! ## A handle that is not exactly one row is a hard error
//!
//! Not a warning, not a skip, and not "take the first". A handle matching two
//! rows means the world grew a row that collides with a story row, and a case
//! scored against whichever one sorted first would be a case nobody could
//! read. A handle matching none means the row it names is gone. Both stop the
//! run by name, before a single turn is judged, because both are silent
//! failures otherwise: every candidate gets the case wrong for a reason that
//! has nothing to do with the candidate.
//!
//! ## What a handle may NOT do
//!
//! It may not be a query. There is no substring match, no "first one that looks
//! right", no ordering. A handle is an exact triple plus, where the world holds
//! a live row and a trashed row with the same label, the state that tells them
//! apart. If a row cannot be named exactly, the right fix is in the world, not
//! in a looser matcher.

use std::collections::BTreeMap;

use centraid_evalworld::{Entity, Inventory, State};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Expected, Suite, WriteExpectation};

/// The identifying facts of one row, as a case names it.
///
/// Deliberately the columns an author READS OUT OF `inventory.json` and can
/// check by eye — never an id, never a position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandleSpec {
    /// The logical entity, e.g. `schedule.task`.
    pub entity: String,
    /// The app a member would open this in.
    pub app: String,
    /// The label the inventory carries, EXACTLY.
    pub label: String,
    /// The row's state, where a live row and a trashed row share a label.
    /// Absent means "the state does not disambiguate this one" — and if the
    /// world ever makes it ambiguous, resolution fails loudly rather than
    /// guessing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<State>,
    /// The row's own date, where nothing else tells two rows apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

impl HandleSpec {
    fn matches(&self, row: &Entity) -> bool {
        row.entity == self.entity
            && row.app == self.app
            && row.label == self.label
            && self.state.is_none_or(|state| row.state == state)
            && self
                .date
                .as_ref()
                .is_none_or(|date| row.date.as_deref() == Some(date.as_str()))
    }
}

/// The owner, who is not a row and therefore never a handle.
const ME: &str = "me";

impl Suite {
    /// Turn every handle in this suite into the id the world minted.
    ///
    /// Called once, after the world is built and before anything is scored.
    ///
    /// # Errors
    ///
    /// A handle that resolves to anything other than exactly one row, or a case
    /// that names a handle the suite never declared. Both name the handle.
    pub fn resolve(&mut self, inventory: &Inventory) -> Result<(), String> {
        let mut resolved: BTreeMap<String, String> = BTreeMap::new();
        let mut problems: Vec<String> = Vec::new();
        for (handle, spec) in &self.handles {
            let found: Vec<&Entity> = inventory
                .entities
                .iter()
                .filter(|row| spec.matches(row))
                .collect();
            match found.as_slice() {
                [row] => {
                    resolved.insert(handle.clone(), row.id.clone());
                }
                [] => problems.push(format!(
                    "{handle}: no row in the world is a {} {} labelled {:?}",
                    spec.app, spec.entity, spec.label
                )),
                many => problems.push(format!(
                    "{handle}: {} rows match — {}; add a `state` or a `date`, or stop the \
                     world minting a second row with this exact label",
                    many.len(),
                    many.iter()
                        .map(|row| row.id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            }
        }
        if !problems.is_empty() {
            return Err(format!(
                "{} handle(s) do not name exactly one row:\n  {}",
                problems.len(),
                problems.join("\n  ")
            ));
        }

        let mut unknown: Vec<String> = Vec::new();
        for session in &mut self.sessions {
            for (index, turn) in session.turns.iter_mut().enumerate() {
                let at = format!("{}/turn {}", session.id, index + 1);
                match &mut turn.expected {
                    Expected::Ids { ids, .. } => {
                        for id in ids.iter_mut() {
                            swap(id, &resolved, &at, &mut unknown);
                        }
                    }
                    Expected::Write { args, .. } => swap_args(args, &resolved, &at, &mut unknown),
                    Expected::WriteSet { writes, .. } => {
                        for WriteExpectation { args, .. } in writes.iter_mut() {
                            swap_args(args, &resolved, &at, &mut unknown);
                        }
                    }
                    Expected::Value { .. } | Expected::NoAction { .. } => {}
                }
            }
        }
        if unknown.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} case(s) name a handle the suite does not declare:\n  {}",
                unknown.len(),
                unknown.join("\n  ")
            ))
        }
    }
}

/// One id, replaced in place. An id that is not a declared handle is an error
/// rather than a passthrough: a pasted uuid would otherwise still work, and the
/// whole point is that it must not.
fn swap(id: &mut String, resolved: &BTreeMap<String, String>, at: &str, unknown: &mut Vec<String>) {
    match resolved.get(id.as_str()) {
        Some(found) => id.clone_from(found),
        None => unknown.push(format!("{at}: {id}")),
    }
}

/// Every argument that NAMES A ROW — `id`, or anything ending `_id`. The other
/// arguments of a write are days, amounts and titles, and a handle is not one.
fn swap_args(
    args: &mut Map<String, Value>,
    resolved: &BTreeMap<String, String>,
    at: &str,
    unknown: &mut Vec<String>,
) {
    for (key, value) in args.iter_mut() {
        if key != "id" && !key.ends_with("_id") {
            continue;
        }
        let Some(text) = value.as_str() else { continue };
        if text == ME {
            continue;
        }
        let mut id = text.to_owned();
        swap(&mut id, resolved, &format!("{at}: {key}"), unknown);
        *value = Value::String(id);
    }
}
