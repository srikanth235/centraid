//! THE SUITE'S OWN GATE — every expectation checked against the seeded world.
//!
//! A corpus is only worth its ground truth, and the cheapest way for a corpus
//! to be worthless is for it to name a row that does not exist. An author
//! writing `schedule.task/0191…` from memory, an id copied from a stale build,
//! an entity spelled `core.task` because that is what it sounds like — none of
//! those fail loudly at scoring time. They fail *quietly*, as a case every
//! candidate runtime gets wrong for a reason that has nothing to do with the
//! candidate.
//!
//! So this binary refuses the suite rather than the model:
//!
//! * every `ids` id exists in `inventory.json`, and carries the entity the case
//!   claims for it;
//! * every entity name is one the world actually seeds;
//! * every `*_id` argument of a write that looks like a seeded id *is* one;
//! * the session, turn and predicate shapes are well formed.
//!
//! It is deliberately standalone — it parses `suite.json` with its own structs
//! rather than through the crate's library, because the thing being validated
//! is the FILE, and a validator that shared a parser with the runtime would
//! only ever prove the two agreed with each other.
//!
//! ```bash
//! cargo run -p centraid-evalsuite --bin validate-suite
//! cargo run -p centraid-evalsuite --bin validate-suite -- suite.json inventory.json
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use centraid_evalsuite::reference::calendar::{self, Window};
use centraid_evalworld::Inventory;
use serde::Deserialize;

const DEFAULT_SUITE: &str = "crates/evalsuite/suite.json";
const DEFAULT_INVENTORY: &str = "target/eval-world/inventory.json";
/// Where `--world 2` looks for the SECOND world's inventory when the caller
/// names no path. A different world is a different set of rows, and a corpus
/// validated against the wrong one fails on every handle at once.
const DEFAULT_INVENTORY_SECOND: &str = "target/eval-world-2/inventory.json";

/// The wildcard entity: an answer whose rows legitimately span more than one
/// entity (a day window that crosses the calendar and the board, a broad noun
/// that lands in five apps). Documented in the README; the ids are still
/// checked one by one, only the single-entity claim is relaxed.
const MIXED: &str = "*";

/// Every category the corpus is allowed to use.
///
/// A closed set on purpose: a typo in a category is a silently mis-counted
/// coverage report, and the README quotes these counts.
const CATEGORIES: &[&str] = &[
    "single_read",
    "narrowing_followup",
    "reference_into_result",
    "deictic",
    "cross_app_hop",
    // A CROSS-APP ANSWER THAT CANNOT BE REACHED IN ONE APP. `cross_app_hop`
    // names a session that HOPS — one app per turn; `cross_app` names one
    // whose single correct answer is a join, through the attendee list, the
    // place row, the album, the folder or the obligation. The two are counted
    // apart because the second is the one a single-table reader cannot fake.
    "cross_app",
    // FIVE TO EIGHT TURNS WITH REAL STATE IN THEM. Every turn after the first
    // depends on the ones before it: a pro-form, an ordinal into the previous
    // answer, a refinement, a resumption of a dropped thread, or a write on a
    // row surfaced several turns earlier. Enforced, not asserted in prose —
    // see `deep_sessions_depend_on_their_own_history`.
    "deep",
    "mixed_read_write",
    "correction",
    "abandonment",
    "ambiguity_clarify",
    "refusal",
    "locker_only",
    "abstract_temporal",
    "write_only",
    "value_read",
    "write_set",
    // A REAL UNDO: a turn that takes back a write that landed. The corpus's
    // other `undo`-shaped turns are WITHDRAWALS — nothing had been written, so
    // nothing is rolled back — and filing the two under one name would make
    // the count say something it does not mean.
    "undo",
];

/// Every write predicate the corpus is allowed to assert.
///
/// Outcome names, not command names — the suite is architecture-neutral and
/// must not smuggle in a particular call shape. Each one is nevertheless
/// answerable by a typed command that exists in `crates/vault/src/commands`,
/// which is what keeps the vocabulary honest.
const PREDICATES: &[&str] = &[
    "task_created",
    "task_completed",
    "task_rescheduled",
    "event_created",
    "event_rescheduled",
    "note_created",
    "document_trashed",
    "document_starred",
    "expense_added",
    "debt_settled",
    "interaction_logged",
    // NOTHING WAS LOGGED AGAINST THIS ONE — the half of a paired write that
    // turns "she picked the right person" from a hope into a score. It was
    // implemented and scored before it was admissible here, and a corpus lane
    // correctly refused to widen this list to go green: the omission cost three
    // real cases rather than being hidden.
    "no_interaction_logged",
    "event_cancelled",
    "task_trashed",
    "photo_added_to_album",
    "locker_item_created",
    "locker_field_revealed",
    "settled_up",
    // THE UNDO PREDICATES. Five typed restore commands existed in the registry
    // with no turn reaching one, which on a corpus that scores writes is a hole
    // on the write side.
    "task_restored",
    "document_restored",
    "asset_restored",
    "expense_trashed",
    "expense_undone",
    "person_trashed",
    "person_undone",
];

/// Predicates whose effect the SEEDED WORLD ALREADY SATISFIES unless the case
/// says what changed, and the argument that has to say it.
///
/// The failure this exists to stop is subtle and was found by a reference run
/// rather than by reading: `interaction_logged{party_id}` is true of Neha
/// Kulkarni *before the conversation starts*, because the world logs a call
/// with her at seed time. A candidate that did nothing at all passed the case.
/// A `since` makes the assertion "an interaction logged ON OR AFTER today",
/// which only the candidate's own write can satisfy. The same reasoning gives
/// a reschedule its `to` and a settlement its amount.
const DISCRIMINATING_ARGUMENT: &[(&str, &str)] = &[
    ("interaction_logged", "since"),
    // THE NEGATIVE NEEDS ONE TOO, and for the same reason read backwards: with
    // no `since`, "nothing is logged against her" is satisfied by a world that
    // simply never logged anything, which is seed state and not evidence. With
    // one, it asserts nothing was logged TODAY — which only a candidate writing
    // against the wrong person can falsify.
    ("no_interaction_logged", "since"),
    ("task_rescheduled", "to"),
    ("event_rescheduled", "to"),
    ("debt_settled", "amount_minor"),
    ("settled_up", "amount_minor"),
    // AN UNDO ERASES ITS OWN EVIDENCE: a row restored looks exactly like a row
    // that was never trashed. Where the vault RECORDS the change before making
    // it, the case says WHEN and that recording is the discriminator. The
    // `document_restored` takes an `on` — a DAY — rather than a `since`,
    // because `core_document.updated_at` is rewritten by a trigger from the
    // WALL clock (DEFECT #26) and an "at or after" would be satisfied by a
    // stamp out of the real present. `task_restored` and `asset_restored` take
    // neither: their commands write no stamp at all, so they discriminate
    // structurally instead — each names a row the WORLD SEEDS IN THE TRASH,
    // which is not live before the turn. Demanding an argument they cannot
    // read would be a guard that never fires, which is the defect this table
    // exists to stop.
    // NOT USED BY ANY CASE TODAY, and listed anyway: `core.restore_document`'s
    // success path is unreachable in this world (DEFECTS #26/#27), so the
    // predicate waits. A future case must still say WHEN, and `on` — a day —
    // rather than `since`, because the column it reads is rewritten by a
    // trigger from the wall clock and an "at or after" would always hold.
    ("document_restored", "on"),
    ("expense_undone", "since"),
    ("person_undone", "since"),
];

/// Units a `value` expectation may carry.
///
/// Closed, because the whole point of the shape is that the number is scored:
/// `52087` with a free-text unit is a number whose meaning a scorer has to
/// guess, and `"usd"` against minor units is the exact mistake the shape was
/// added to catch.
const UNITS: &[&str] = &["usd_minor", "days", "photos", "items", "tasks"];

#[derive(Debug, Deserialize)]
struct Suite {
    version: u32,
    today: String,
    /// THE HANDLE TABLE. Re-declared here rather than imported, for the same
    /// reason every other struct in this file is: the thing being validated is
    /// the FILE, and a validator sharing a parser with the runtime only ever
    /// proves the two agree with each other.
    #[serde(default)]
    handles: BTreeMap<String, HandleSpec>,
    sessions: Vec<Session>,
}

#[derive(Debug, Deserialize)]
struct HandleSpec {
    entity: String,
    app: String,
    label: String,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

impl HandleSpec {
    fn matches(&self, row: &centraid_evalworld::Entity) -> bool {
        let state = match row.state {
            centraid_evalworld::State::Live => "live",
            centraid_evalworld::State::Trashed => "trashed",
            centraid_evalworld::State::Completed => "completed",
        };
        row.entity == self.entity
            && row.app == self.app
            && row.label == self.label
            && self.state.as_deref().is_none_or(|wanted| wanted == state)
            && self
                .date
                .as_deref()
                .is_none_or(|wanted| row.date.as_deref() == Some(wanted))
    }
}

/// What a raw uuid looks like, so the one thing handles exist to forbid is
/// forbidden by name rather than by hope.
fn looks_like_a_uuid(text: &str) -> bool {
    text.len() == 36
        && text
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => *byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            })
}

#[derive(Debug, Deserialize)]
struct Session {
    id: String,
    category: String,
    #[serde(default)]
    notes: String,
    turns: Vec<Turn>,
}

#[derive(Debug, Deserialize)]
struct Turn {
    request: String,
    expected: Expected,
    /// The member put one thread down and picked up another. Declared by the
    /// case, because a turn that wanders carries no pro-form and the depth
    /// check must be able to tell wandering from a question nobody thought
    /// about — see [`check_depth`].
    #[serde(default)]
    topic_switch: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Expected {
    Ids {
        entity: String,
        ids: Vec<String>,
        #[serde(default)]
        ordered: bool,
        /// The sort the case asserts, in words. See the crate's `Expected`.
        #[serde(default)]
        order_by: Option<String>,
    },
    Write {
        predicate: String,
        #[serde(default)]
        args: BTreeMap<String, serde_json::Value>,
    },
    NoAction {
        reason: String,
        #[serde(default)]
        why: String,
    },
    /// An aggregate: a sum, a balance or a count. The STRICTER reading of a
    /// question that also has a retrieval reading — retrieve-right-sum-wrong
    /// passes an `ids` case and fails this one.
    Value {
        value: serde_json::Number,
        unit: Option<String>,
        /// HOW THIS NUMBER IS DERIVED FROM THE WORLD, when it is derived from
        /// the world rather than named by hand. See [`Recompute`].
        #[serde(default)]
        recompute: Option<Recompute>,
    },
    /// Several writes, all of which must hold. One request, more than one row.
    WriteSet {
        writes: Vec<WriteStep>,
        /// Refused, never scored. See the crate's `Expected::WriteSet`.
        #[serde(default)]
        ordered: bool,
    },
}

/// **A VALUE THAT CAN BE RECOMPUTED, AND THEREFORE CHECKED.**
///
/// A case asking what a pile of rows adds up to carries a literal — and a
/// literal over hundreds of seeded rows is an expectation that stops being true
/// the moment the world's seeding changes, silently, with nothing to catch it.
/// It is the same defect stable handles closed for row ids, still open for
/// aggregates: the row-id form now fails loudly on drift, the aggregate form
/// used to carry a prose `note` asking a future editor to remember.
///
/// A case that declares how its number is derived gets the guard instead: the
/// validator recomputes it from the inventory the world just built and refuses
/// the suite when the two disagree. It does NOT replace the literal — the
/// literal is what scores, so a candidate is never graded against a number the
/// harness computed for itself in the same pass. The literal is the claim; this
/// is the proof that the claim still holds.
#[derive(Debug, Deserialize)]
struct Recompute {
    /// `sum` over each row's recorded value, or `count` of the rows.
    op: String,
    app: String,
    entity: String,
    /// Matched case-insensitively against the row's label.
    #[serde(default)]
    label_contains: String,
    /// THE ROWS NAMED OUTRIGHT, for a pile that shares no substring.
    ///
    /// `label_contains` describes the piles that happen to be named after the
    /// thing they have in common — everything at one merchant. It cannot
    /// describe a trip whose four expenses are a deposit, some petrol, some
    /// groceries and a pair of lift passes. Those are named, exactly and in
    /// full; a row matching none of them is not in the pile.
    #[serde(default)]
    label_in: Vec<String>,
    /// **THE ROW'S OWN ATTRIBUTES, ALL OF WHICH MUST MATCH.**
    ///
    /// `{"group": "Tahoe Trip"}` is the pile; `{"paid_by": "Sam Whitaker"}`
    /// narrows it to the part one person paid for. Deliberately a map rather
    /// than a field per attribute: the world decides which facts a row records
    /// (see `Entity::facts`), and a validator that hard-coded `group` and
    /// `paid_by` would have to be edited again for the next question. A fact
    /// the row does not carry never matches, so a typo fails loudly rather than
    /// widening the pile.
    #[serde(default)]
    facts: BTreeMap<String, String>,
    /// `live` unless stated. A total over trashed rows is a different total.
    #[serde(default)]
    state: Option<String>,
    /// **THE WINDOW, WHERE THE PILE IS A WINDOW.**
    ///
    /// "How much did I spend last month" names no label and no attribute: the
    /// pile is every row whose own date falls in a month. `date_prefix` is
    /// that month (`"2026-05"`) or that day (`"2026-06-15"`); `date_from` and
    /// `date_to` are an inclusive span of days for a window that is not a
    /// calendar unit, and `date_before` is the open-ended one an overdue
    /// question needs. All of them compare the first characters of the row's
    /// own date, so a timestamp and a bare day compare alike.
    ///
    /// A row with NO date matches none of them. That is the answer a "someday"
    /// task should give a question about a week.
    #[serde(default)]
    date_prefix: String,
    #[serde(default)]
    date_from: String,
    #[serde(default)]
    date_to: String,
    #[serde(default)]
    date_before: String,
}

impl Recompute {
    /// The number this description names, read off the world.
    ///
    /// `None` when the description is not one this understands, which is a
    /// problem the caller reports rather than one it silently passes.
    /// Whether the row's own date falls in the window this description names.
    /// No window named is every row; a window named and no date is no row.
    fn in_window(&self, date: Option<&str>) -> bool {
        let wanted = !self.date_prefix.is_empty()
            || !self.date_from.is_empty()
            || !self.date_to.is_empty()
            || !self.date_before.is_empty();
        if !wanted {
            return true;
        }
        let Some(date) = date else { return false };
        let day = date.get(..10).unwrap_or(date);
        if !self.date_prefix.is_empty() && !date.starts_with(&self.date_prefix) {
            return false;
        }
        if !self.date_from.is_empty() && day < self.date_from.as_str() {
            return false;
        }
        if !self.date_to.is_empty() && day > self.date_to.as_str() {
            return false;
        }
        if !self.date_before.is_empty() && day >= self.date_before.as_str() {
            return false;
        }
        true
    }

    fn apply(&self, inventory: &Inventory) -> Option<f64> {
        let needle = self.label_contains.to_lowercase();
        let wanted_state = self.state.as_deref().unwrap_or("live");
        let rows = inventory.entities.iter().filter(|row| {
            row.app == self.app
                && row.entity == self.entity
                && row.label.to_lowercase().contains(&needle)
                && (self.label_in.is_empty() || self.label_in.contains(&row.label))
                && self
                    .facts
                    .iter()
                    .all(|(key, want)| row.facts.get(key) == Some(want))
                && self.in_window(row.date.as_deref())
                && format!("{:?}", row.state).to_lowercase() == wanted_state
        });
        match self.op.as_str() {
            #[expect(clippy::cast_precision_loss, reason = "a count of rows")]
            "count" => Some(rows.count() as f64),
            "sum" => {
                let mut total = 0.0_f64;
                for row in rows {
                    // A ROW WITH NO RECORDED VALUE CANNOT BE SUMMED, and
                    // treating it as zero would quietly answer a different
                    // question. The whole recomputation fails instead.
                    total += row.value.as_ref()?.parse::<f64>().ok()?;
                }
                Some(total)
            }
            // **ONE ROW'S OWN SCALAR**, for a question whose answer is a field
            // rather than an aggregate — a contact cadence, a debt's balance.
            // EXACTLY ONE ROW MAY MATCH: a description that reaches two rows
            // is a description of neither, and answering with the first would
            // guard the number against nothing.
            "value" => {
                let matched: Vec<&centraid_evalworld::Entity> = rows.collect();
                match matched.as_slice() {
                    [row] => row.value.as_ref()?.parse::<f64>().ok(),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct WriteStep {
    predicate: String,
    #[serde(default)]
    args: BTreeMap<String, serde_json::Value>,
}

/// One write, checked: the predicate is known, it carries arguments, and every
/// argument that names a row names one the world holds.
fn check_write(
    at: &str,
    predicate: &str,
    args: &BTreeMap<String, serde_json::Value>,
    by_id: &BTreeMap<&str, &centraid_evalworld::Entity>,
    apps_touched: &mut BTreeSet<String>,
    problems: &mut Vec<String>,
) {
    if !PREDICATES.contains(&predicate) {
        problems.push(format!("{at}: unknown write predicate {predicate:?}"));
    }
    if args.is_empty() {
        problems.push(format!("{at}: a write with no arguments"));
    }
    for (needs, argument) in DISCRIMINATING_ARGUMENT {
        if predicate == *needs && !args.contains_key(*argument) {
            problems.push(format!(
                "{at}: {predicate} without {argument:?} is satisfied by the seeded world, \
                 not by the candidate"
            ));
        }
    }
    for (key, value) in args {
        if key != "id" && !key.ends_with("_id") {
            continue;
        }
        let Some(text) = value.as_str() else { continue };
        // "me" is the vault's owner, who is not an inventory row.
        if text == "me" {
            continue;
        }
        if looks_like_a_uuid(text) {
            problems.push(format!(
                "{at}: {key}={text} is a raw uuid — name the row by a stable handle instead"
            ));
            continue;
        }
        match by_id.get(text) {
            Some(row) => {
                apps_touched.insert(row.app.clone());
            }
            None => problems.push(format!("{at}: {key}={text} is not a declared handle")),
        }
    }
}

fn main() -> std::process::ExitCode {
    let (world, positional) = match world_switch() {
        Ok(parsed) => parsed,
        Err(why) => {
            eprintln!("validate-suite: {why}");
            return std::process::ExitCode::from(2);
        }
    };
    let mut args = positional.into_iter();
    let suite_path = PathBuf::from(args.next().unwrap_or_else(|| DEFAULT_SUITE.to_owned()));
    let inventory_path = PathBuf::from(args.next().unwrap_or_else(|| {
        match world {
            centraid_evalworld::Scenario::First => DEFAULT_INVENTORY,
            centraid_evalworld::Scenario::Second => DEFAULT_INVENTORY_SECOND,
        }
        .to_owned()
    }));

    let mut problems: Vec<String> = Vec::new();

    let inventory: Inventory = match std::fs::read_to_string(&inventory_path)
        .map_err(|error| format!("{}: {error}", inventory_path.display()))
        .and_then(|text| {
            serde_json::from_str(&text)
                .map_err(|error| format!("{}: {error}", inventory_path.display()))
        }) {
        Ok(inventory) => inventory,
        Err(why) => {
            eprintln!("the inventory could not be read: {why}");
            eprintln!(
                "build the world first: cargo run -p centraid-evalworld \
                 --bin build-eval-world -- target/eval-world"
            );
            return std::process::ExitCode::FAILURE;
        }
    };

    let suite: Suite = match std::fs::read_to_string(&suite_path)
        .map_err(|error| format!("{error}"))
        .and_then(|text| serde_json::from_str(&text).map_err(|error| format!("{error}")))
    {
        Ok(suite) => suite,
        Err(why) => {
            eprintln!("{}: the suite is malformed: {why}", suite_path.display());
            return std::process::ExitCode::FAILURE;
        }
    };

    // EVERY HANDLE, RESOLVED — exactly one row each, or the suite is refused.
    //
    // This is the check that makes growing the world safe: a bulk row that
    // collides with a story row's app, entity and label makes the handle
    // ambiguous, and ambiguity stops the suite here rather than silently
    // scoring against whichever row sorted first.
    let mut by_id: BTreeMap<&str, &centraid_evalworld::Entity> = BTreeMap::new();
    for (handle, spec) in &suite.handles {
        let found: Vec<&centraid_evalworld::Entity> = inventory
            .entities
            .iter()
            .filter(|row| spec.matches(row))
            .collect();
        match found.as_slice() {
            [row] => {
                by_id.insert(handle.as_str(), row);
            }
            [] => problems.push(format!(
                "handle {handle}: no row in the world is a {} {} labelled {:?}",
                spec.app, spec.entity, spec.label
            )),
            many => problems.push(format!(
                "handle {handle}: {} rows match — add a `state` or a `date`, or stop the \
                 world minting a second row with this exact label",
                many.len()
            )),
        }
    }
    let entity_names: BTreeSet<&str> = inventory
        .entities
        .iter()
        .map(|entity| entity.entity.as_str())
        .collect();

    if suite.version != 1 {
        problems.push(format!("version {} is not 1", suite.version));
    }
    if suite.today != inventory.now[..10] {
        problems.push(format!(
            "suite.today {} disagrees with the world's now {}",
            suite.today, inventory.now
        ));
    }

    let mut seen_sessions: BTreeSet<&str> = BTreeSet::new();
    let mut categories: BTreeMap<&str, usize> = BTreeMap::new();
    let mut apps_touched: BTreeSet<String> = BTreeSet::new();
    let mut turns = 0usize;
    let mut reads = 0usize;
    let mut writes = 0usize;
    let mut no_actions = 0usize;
    let mut values = 0usize;
    let mut recomputed = 0usize;
    let mut write_sets = 0usize;

    for session in &suite.sessions {
        let at = |turn: usize| format!("{}/turn {}", session.id, turn + 1);
        if !seen_sessions.insert(session.id.as_str()) {
            problems.push(format!("{}: duplicate session id", session.id));
        }
        if !CATEGORIES.contains(&session.category.as_str()) {
            problems.push(format!(
                "{}: unknown category {:?}",
                session.id, session.category
            ));
        }
        *categories.entry(session.category.as_str()).or_default() += 1;
        if session.turns.is_empty() {
            problems.push(format!("{}: no turns", session.id));
        }
        if session.notes.trim().is_empty() {
            problems.push(format!("{}: no notes — say why the session exists", session.id));
        }

        for (index, turn) in session.turns.iter().enumerate() {
            turns += 1;
            if turn.request.trim().is_empty() {
                problems.push(format!("{}: empty request", at(index)));
            }
            match &turn.expected {
                Expected::Ids {
                    entity,
                    ids,
                    ordered,
                    order_by,
                } => {
                    reads += 1;
                    if entity != MIXED && !entity_names.contains(entity.as_str()) {
                        problems.push(format!(
                            "{}: {entity:?} is not an entity the world seeds",
                            at(index)
                        ));
                    }
                    if *ordered && ids.len() < 2 {
                        problems.push(format!(
                            "{}: ordered:true on {} id(s) asserts nothing",
                            at(index),
                            ids.len()
                        ));
                    }
                    // AN ORDER NOBODY WROTE DOWN is not a validator failure:
                    // three live cases are in exactly that state, and turning
                    // the validator red on them would only invite somebody to
                    // delete the check. The run reports name each one in the
                    // UNDECLARED ORDERING register instead, where it is read
                    // beside the score it qualifies.
                    if !*ordered && order_by.is_some() {
                        problems.push(format!(
                            "{}: `order_by` on an unordered case asserts nothing",
                            at(index)
                        ));
                    }
                    let mut seen: BTreeSet<&str> = BTreeSet::new();
                    for id in ids {
                        if !seen.insert(id.as_str()) {
                            problems.push(format!("{}: {id} appears twice", at(index)));
                        }
                        if looks_like_a_uuid(id) {
                            problems.push(format!(
                                "{}: {id} is a raw uuid — name the row by a stable handle instead",
                                at(index)
                            ));
                            continue;
                        }
                        match by_id.get(id.as_str()) {
                            None => problems.push(format!(
                                "{}: {id} is not a handle the suite declares",
                                at(index)
                            )),
                            Some(row) => {
                                apps_touched.insert(row.app.clone());
                                if entity != MIXED && &row.entity != entity {
                                    problems.push(format!(
                                        "{}: {id} is a {} ({}), not a {entity}",
                                        at(index),
                                        row.entity,
                                        row.label
                                    ));
                                }
                            }
                        }
                    }
                    if entity == MIXED && ids.len() < 2 {
                        problems.push(format!(
                            "{}: the mixed entity {MIXED:?} needs more than one row",
                            at(index)
                        ));
                    }
                }
                Expected::Write { predicate, args } => {
                    writes += 1;
                    check_write(
                        &at(index),
                        predicate,
                        args,
                        &by_id,
                        &mut apps_touched,
                        &mut problems,
                    );
                }
                Expected::WriteSet {
                    writes: steps,
                    ordered: write_order,
                } => {
                    write_sets += 1;
                    // ORDER BETWEEN WRITES IS NOT SCOREABLE HERE. Predicates
                    // read the vault AFTER the turn, and two orderings of the
                    // same writes leave the same vault. Refused loudly rather
                    // than ignored, so no case is written in the belief that
                    // it is being checked.
                    if *write_order {
                        problems.push(format!(
                            "{}: a write_set cannot declare an order — the harness scores \
                             end state, which cannot witness the order writes arrived in",
                            at(index)
                        ));
                    }
                    if steps.len() < 2 {
                        problems.push(format!(
                            "{}: a write_set of {} is a write",
                            at(index),
                            steps.len()
                        ));
                    }
                    let mut targets: BTreeSet<String> = BTreeSet::new();
                    for step in steps {
                        check_write(
                            &at(index),
                            &step.predicate,
                            &step.args,
                            &by_id,
                            &mut apps_touched,
                            &mut problems,
                        );
                        // TWO WRITES AT THE SAME ROW WITH THE SAME PREDICATE is
                        // a copy-paste, not a plural request.
                        let target = format!(
                            "{}::{}",
                            step.predicate,
                            step.args
                                .get("id")
                                .or_else(|| step.args.get("party_id"))
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("-")
                        );
                        if !targets.insert(target.clone()) {
                            problems.push(format!("{}: {target} is written twice", at(index)));
                        }
                    }
                }
                Expected::Value {
                    value,
                    unit,
                    recompute,
                } => {
                    values += 1;
                    match unit {
                        None => problems.push(format!(
                            "{}: a value with no unit is a number nobody can score",
                            at(index)
                        )),
                        Some(unit) if !UNITS.contains(&unit.as_str()) => problems
                            .push(format!("{}: unknown unit {unit:?}", at(index))),
                        Some(_) => {}
                    }
                    if value.as_f64().is_some_and(|number| number < 0.0) {
                        problems.push(format!(
                            "{}: a negative value — say which direction the question asks",
                            at(index)
                        ));
                    }
                    // THE GUARD. See [`Recompute`]: a declared derivation is
                    // recomputed from the world that was just built, and a
                    // disagreement refuses the suite by name rather than
                    // scoring every candidate against a number that quietly
                    // stopped being true.
                    if let Some(recompute) = recompute {
                        recomputed += 1;
                        match recompute.apply(&inventory) {
                            Some(found)
                                if value.as_f64().is_some_and(|want| {
                                    (want - found).abs() < 0.5
                                }) => {}
                            Some(found) => problems.push(format!(
                                "{}: the case says {value}, the world says {found} —                                  the world changed under this expectation",
                                at(index)
                            )),
                            None => problems.push(format!(
                                "{}: `recompute` names no derivation this validator can                                  perform ({:?} over {} {}), so the number is unguarded",
                                at(index),
                                recompute.op,
                                recompute.app,
                                recompute.entity
                            )),
                        }
                    }
                }
                Expected::NoAction { reason, why } => {
                    no_actions += 1;
                    if !matches!(reason.as_str(), "clarify" | "refuse" | "none") {
                        problems.push(format!("{}: unknown reason {reason:?}", at(index)));
                    }
                    if why.trim().is_empty() {
                        problems.push(format!(
                            "{}: a no_action with no stated reason is unscoreable by a human",
                            at(index)
                        ));
                    }
                }
            }
        }
    }

    // THE OPENING CHECK. A first turn may not point at a turn that is not in
    // its session — see [`check_openings`].
    let openings = check_openings(&suite, &mut problems);

    // THE DEPTH CHECK. A `deep` session's later turns must actually depend on
    // its earlier ones — see [`check_depth`].
    let depth = check_depth(&suite, &mut problems);

    // THE TEMPORAL CHECK. Every request that names a period must expect rows
    // inside it — see [`check_temporal`].
    let temporal = check_temporal(&suite, &by_id, &mut problems);

    // EVERY AGGREGATE IS RECOMPUTED, OR IT IS ON THE LIST WITH A REASON —
    // see [`check_every_value_is_guarded`].
    check_every_value_is_guarded(&suite, &mut problems);

    // ADVISORY, NEVER A FAILURE: turns whose words imply an order that the
    // case does not assert — see [`report_implied_ordering`].
    let implied = report_implied_ordering(&suite);

    // Coverage is a property of the SUITE, not of a case, so it is reported
    // rather than asserted — except for the eight apps, which the brief names.
    let every_app: BTreeSet<&str> = inventory
        .entities
        .iter()
        .map(|entity| entity.app.as_str())
        .collect();
    for app in &every_app {
        if !apps_touched.contains(*app) {
            problems.push(format!("no case names a row in {app}"));
        }
    }

    if implied.is_empty() {
        println!(
            "ordering   no ids turn's request implies an order the case leaves unasserted"
        );
    } else {
        println!(
            "ordering   {} ids turn(s) whose request implies an order with `ordered` unset \
             (ADVISORY — DEFECTS.md #B9):",
            implied.len()
        );
        for (key, request, cue, ids) in &implied {
            println!("             {key} {request:?} — {cue:?}, {ids} expected id(s)");
        }
    }
    println!("suite      {}", suite_path.display());
    println!("world      {}", inventory_path.display());
    println!(
        "sessions   {}  turns {turns}  (reads {reads}, values {values}, \
writes {writes}, write_sets {write_sets}, no_action {no_actions})",
        suite.sessions.len()
    );
    println!(
        "apps       {}",
        apps_touched.iter().map(String::as_str).collect::<Vec<_>>().join(" ")
    );
    for (category, count) in &categories {
        println!("  {category:<22} {count}");
    }
    // AN AGGREGATE WITHOUT A DERIVATION IS A NUMBER NOBODY CAN RECHECK, and
    // this line is how many of each there are. It is not a failure: a balance
    // or a count over a handful of story rows is readable by eye. It is a
    // failure waiting to happen once the pile is in the hundreds, which is why
    // the count is printed beside the score rather than left to be noticed.
    if values > 0 {
        println!(
            "values     {recomputed} of {values} recomputed from the world; {} named by hand",
            values - recomputed
        );
    }

    // ---- LANE W: the two write-side checks -------------------------------
    // Added as their own functions, called here, so the checks above are
    // untouched. See DEFECT #17.
    check_every_predicate_is_licensed(&mut problems);
    check_no_claimed_write_passes_on_an_untouched_world(&suite_path, world, &mut problems);

    println!(
        "depth      {} deep session(s), {} turn(s) after an opening: {} carry a pro-form or a \
         continuation, {} are declared topic switches",
        depth.sessions, depth.later, depth.dependent, depth.switches
    );
    println!(
        "openings   {} opening turn(s) read for a reference they cannot resolve; \
{} carry a deictic answered inside their own sentence, {} are ABOUT the missing \
antecedent and expect no action",
        openings.read, openings.resolved, openings.exempt
    );
    println!(
        "temporal   {} phrase(s) read across {} turn(s); {} expected row(s) checked against \
their window, {} carry no date to check",
        temporal.phrases, temporal.turns, temporal.checked, temporal.undated
    );

    if problems.is_empty() {
        println!("\nOK — every expectation names a row the world actually holds.");
        std::process::ExitCode::SUCCESS
    } else {
        eprintln!("\n{} problem(s):", problems.len());
        for problem in &problems {
            eprintln!("  {problem}");
        }
        std::process::ExitCode::FAILURE
    }
}


// ---------------------------------------------------------------------------
// The depth check: a `deep` session that is really a list of questions.
// ---------------------------------------------------------------------------

/// **WHAT MAKES A LATER TURN A LATER TURN.**
///
/// A pro-form points at the previous answer; a continuation marker points at
/// the thread. Either one means the turn cannot be read on its own, which is
/// the whole claim the `deep` category makes. The list is small and generous
/// in the direction of NOT complaining, like `DEICTIC` above: a marker it
/// forgets makes a case DECLARE a topic switch it did not need to, never the
/// other way round.
const CONTINUATION: &[&str] = &[
    "it", "its", "itself", "that", "this", "these", "those", "them", "they", "their", "her",
    "him", "his", "she", "he", "there", "then", "one", "ones", "same", "else", "again", "now",
    // AN ORDINAL IS A POINTER. "the second task" names nothing on its own —
    // it names a position in the answer the turn before it gave.
    "first", "second", "third", "fourth", "fifth", "other", "another", "both",
];

/// Phrases that carry a thread without using a pronoun at all.
const CONTINUATION_PHRASE: &[&str] = &[
    "back to", "what about", "how about", "just the", "only the", "and ", "so what", "how much",
    "which of", "of those", "of them", "no —", "no,",
];

#[derive(Debug, Default)]
struct Depth {
    sessions: usize,
    later: usize,
    dependent: usize,
    switches: usize,
}

/// **A `deep` SESSION'S LATER TURNS MUST DEPEND ON ITS EARLIER ONES.**
///
/// The category exists to say that a conversation has state in it, and the
/// cheapest way to fake one is five questions in a row that happen to be about
/// the same noun — every one of which a candidate with no memory at all would
/// answer correctly. So every turn after the first must either carry a
/// pro-form or a continuation marker, or DECLARE `topic_switch`, which is the
/// member wandering and is exactly as real. What the check refuses is the
/// third case: a turn that neither continues nor declares, which is a turn
/// nobody decided about.
fn check_depth(suite: &Suite, problems: &mut Vec<String>) -> Depth {
    let mut seen = Depth::default();
    for session in &suite.sessions {
        if session.category != "deep" {
            continue;
        }
        seen.sessions += 1;
        if session.turns.len() < 5 {
            problems.push(format!(
                "{}: a `deep` session has five turns or more; this one has {}",
                session.id,
                session.turns.len()
            ));
        }
        for (index, turn) in session.turns.iter().enumerate().skip(1) {
            seen.later += 1;
            if turn.topic_switch {
                seen.switches += 1;
                continue;
            }
            let lowered = turn.request.to_lowercase();
            let tokens = words(&turn.request);
            let carries = tokens
                .iter()
                .any(|word| CONTINUATION.contains(&word.as_str()))
                || CONTINUATION_PHRASE
                    .iter()
                    .any(|phrase| lowered.contains(phrase));
            if carries {
                seen.dependent += 1;
            } else {
                problems.push(format!(
                    "{}/turn {}: a `deep` turn that neither continues the conversation nor \
                     declares a topic switch ({:?}) — a turn answerable cold is not depth",
                    session.id,
                    index + 1,
                    turn.request
                ));
            }
        }
    }
    seen
}

// ---------------------------------------------------------------------------
// The opening check: a first turn has nothing behind it.
// ---------------------------------------------------------------------------

/// **THE OPENING WORDS THAT CAN ONLY MEAN SOMETHING SAID EARLIER.**
///
/// A small list on purpose. It is not a parser and does not pretend to be one
/// — it is the set of pro-forms that carry no content of their own, so a
/// sentence using one either names its referent somewhere in the same sentence
/// or is pointing outside itself.
const DEICTIC: &[&str] = &[
    "it", "its", "that", "those", "them", "they", "her", "him", "there", "instead", "ones",
];

/// Words that cannot BE an antecedent: closed-class words, and the handful of
/// verbs this corpus opens with. A token outside this set, standing before a
/// pro-form in the same sentence, is treated as the thing it points at.
///
/// Deliberately generous in the direction of NOT complaining: a word this list
/// forgets makes the check miss a violation, never invent one.
const NOT_AN_ANTECEDENT: &[&str] = &[
    "a", "about", "actually", "all", "an", "and", "any", "are", "as", "at", "back", "be", "been",
    "bin", "bring", "by", "can", "cancel", "could", "delete", "did", "do", "does", "down", "far",
    "find", "for", "from", "get", "give", "given", "go", "got", "had", "has", "have", "he", "her",
    "him", "how", "i", "if", "in", "instead", "is", "it", "its", "just", "later", "left", "log",
    "long", "make", "many", "mark", "me", "mine", "move", "much", "my", "myself", "no", "not",
    "now", "of", "off", "on", "one", "ones", "open", "or", "our", "out", "please", "push", "put",
    "remove", "restore", "scratch", "send", "set", "she", "show", "sorry", "star", "still", "take",
    "tell", "text", "that", "the", "their", "them", "then", "there", "these", "they", "this",
    "those", "tick", "to", "undo", "up", "us", "was", "we", "what", "when", "where", "which",
    "who", "whose", "will", "would", "you", "your", "yourself",
];

#[derive(Debug, Default)]
struct Openings {
    read: usize,
    resolved: usize,
    exempt: usize,
}

/// The words of a request, lowercased, in order.
fn words(request: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for character in request.chars() {
        if character.is_ascii_alphabetic() || character == '\'' {
            current.push(character.to_ascii_lowercase());
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// **AN OPENING TURN MAY NOT POINT AT A TURN THAT IS NOT IN ITS SESSION.**
///
/// `b21`'s only turn used to be "how much of that did I pay for myself?" —
/// the antecedent of "that" was the whole of `b20`, a DIFFERENT session, and
/// the blind reference resolved it by remembering the trip group across the
/// boundary. A corpus whose sessions are the unit of scoring cannot have one
/// session's answer depend on another's, and nothing said so.
///
/// A turn that EXPECTS NO ACTION is exempt, and that is not a loophole: `b54`
/// ("move it to Friday", `clarify`) is a case ABOUT an unresolvable reference,
/// and its correct outcome is the question. The check is that a turn is not
/// scored on resolving something it was never given.
fn check_openings(suite: &Suite, problems: &mut Vec<String>) -> Openings {
    let mut seen = Openings::default();
    for session in &suite.sessions {
        let Some(turn) = session.turns.first() else {
            continue;
        };
        seen.read += 1;
        let request = &turn.request;
        let tokens = words(request);
        let lowered = request.trim().to_lowercase();
        let leading = tokens.first().map(String::as_str);
        if leading == Some("and")
            || leading == Some("also")
            || lowered.starts_with("what about")
            || lowered.starts_with("how about")
        {
            if matches!(turn.expected, Expected::NoAction { .. }) {
                seen.exempt += 1;
            } else {
                problems.push(format!(
                    "{}/turn 1: opens as a continuation ({request:?}) — the turn it continues \
                     is not in this session",
                    session.id
                ));
            }
            continue;
        }
        let mut complaint = None;
        for (index, word) in tokens.iter().enumerate() {
            if !DEICTIC.contains(&word.as_str()) {
                continue;
            }
            let next = tokens.get(index + 1).map(String::as_str).unwrap_or("");
            // "log THAT I called her" is a complementiser, not a pronoun.
            if word == "that" && matches!(next, "i" | "we" | "he" | "she" | "they" | "you" | "it")
            {
                continue;
            }
            // "is IT anybody's birthday" is an expletive subject.
            if word == "it"
                && index > 0
                && matches!(tokens[index - 1].as_str(), "is" | "was")
            {
                continue;
            }
            // Something in this sentence can BE the antecedent.
            if tokens[..index]
                .iter()
                .any(|earlier| !NOT_AN_ANTECEDENT.contains(&earlier.as_str()))
            {
                seen.resolved += 1;
                continue;
            }
            complaint = Some(word.clone());
            break;
        }
        if let Some(word) = complaint {
            if matches!(turn.expected, Expected::NoAction { .. }) {
                seen.exempt += 1;
            } else {
                problems.push(format!(
                    "{}/turn 1: {request:?} opens with {word:?} and nothing in the session \
                     answers it — give the session the turn the reference points at, or \
                     name the subject",
                    session.id
                ));
            }
        }
    }
    seen
}

// ---------------------------------------------------------------------------
// The write side (DEFECT #16, #17).
// ---------------------------------------------------------------------------

/// **EVERY ADMISSIBLE PREDICATE CARRIES A SIDE-EFFECT LICENCE.**
///
/// A predicate the scorer can check and cannot bound is a predicate under
/// which a candidate may do the right thing and anything else besides. The
/// two lists drifting apart is exactly how DEFECT #15 happened between this
/// file and `lib.rs`; this is that failure mode caught by name, in the same
/// direction, one seam over.
fn check_every_predicate_is_licensed(problems: &mut Vec<String>) {
    let licensed: BTreeSet<&str> = centraid_evalsuite::licenses().keys().copied().collect();
    for predicate in PREDICATES {
        if !licensed.contains(predicate) {
            problems.push(format!(
                "predicate {predicate:?} is admissible here and has no side-effect licence \
                 in `licenses()`: a case using it cannot be judged on what else it moved"
            ));
        }
    }
    for predicate in &licensed {
        if !PREDICATES.contains(predicate) {
            problems.push(format!(
                "a side-effect licence exists for {predicate:?}, which this validator does \
                 not admit — the two lists have drifted"
            ));
        }
    }
}

/// **A `Plan::Wrote` WITH NO WRITE BEHIND IT MUST FAIL, CASE BY CASE.**
///
/// The property DEFECT #4 was a single instance of: an expectation the SEEDED
/// WORLD already satisfies is a free point that reads as competence.
/// `DISCRIMINATING_ARGUMENT` above is a list of the three predicates somebody
/// noticed; this is the property itself, asked of every write the suite names
/// by running the scorer against an untouched world.
///
/// It builds a world, which is the only expensive thing this validator does.
/// That is the price of the check being about the WORLD rather than about the
/// shape of the JSON — and the cheap version is what let `s74/t1` pass for two
/// releases on a settlement the world had already recorded.
fn check_no_claimed_write_passes_on_an_untouched_world(
    suite_path: &std::path::Path,
    world: centraid_evalworld::Scenario,
    problems: &mut Vec<String>,
) {
    let template = match centraid_evalsuite::WorldTemplate::build_scenario(world) {
        Ok(template) => template,
        Err(why) => {
            problems.push(format!(
                "the world does not build, so no write can be checked: {why}"
            ));
            return;
        }
    };
    let mut suite = match centraid_evalsuite::Suite::read(suite_path) {
        Ok(suite) => suite,
        Err(why) => {
            problems.push(format!("the suite does not read as a suite: {why}"));
            return;
        }
    };
    if let Err(why) = suite.resolve(&template.inventory) {
        problems.push(format!(
            "the suite does not resolve against this world: {why}"
        ));
        return;
    }
    // A CANDIDATE THAT SAYS IT WROTE AND WROTE NOTHING. Its changed-row set is
    // empty and its command count is zero, which is the whole point: every
    // write turn must refuse it.
    struct Narrator;
    impl centraid_evalsuite::Candidate for Narrator {
        fn turn(
            &mut self,
            _request: &str,
            _ctx: &mut centraid_evalsuite::Context<'_>,
        ) -> centraid_evalsuite::Plan {
            centraid_evalsuite::Plan::Wrote
        }
    }
    impl centraid_evalsuite::CandidateRuntime for Narrator {
        fn name(&self) -> &str {
            "validate-suite/Narrator"
        }
        fn session(
            &self,
            _session: &centraid_evalsuite::Session,
        ) -> Box<dyn centraid_evalsuite::Candidate> {
            Box::new(Self)
        }
    }
    let report = match centraid_evalsuite::run(&suite, &template, &Narrator) {
        Ok(report) => report,
        Err(why) => {
            problems.push(format!("the narrator run did not finish: {why}"));
            return;
        }
    };
    let mut checked = 0usize;
    for (session, expected) in report.sessions.iter().zip(suite.sessions.iter()) {
        for (index, (turn, case)) in session.turns.iter().zip(expected.turns.iter()).enumerate() {
            let is_write = matches!(
                case.expected,
                centraid_evalsuite::Expected::Write { .. }
                    | centraid_evalsuite::Expected::WriteSet { .. }
            );
            if !is_write {
                continue;
            }
            checked += 1;
            if turn.passed {
                problems.push(format!(
                    "{}/t{}: the write is satisfied by the SEEDED WORLD — a candidate that \
                     says it wrote and writes nothing passes this case",
                    session.id,
                    index + 1
                ));
            }
        }
    }
    println!("writes     {checked} checked against an untouched world; none may pass");
}

// ---------------------------------------------------------------------------
// THE TEMPORAL CHECK — a case's words against the window they denote.
// ---------------------------------------------------------------------------

/// **A CASE'S LANGUAGE MUST MATCH THE WORLD IT IS ASKED AGAINST.**
///
/// `DEFECTS.md` #5 and the unguarded-property list's item 3: `s81` asked
/// about "last weekend" while the only journal entry sat on a Monday, so a
/// candidate that implemented Saturday–Sunday correctly answered nothing and
/// was marked wrong for being right. It was found by a reference run, by
/// luck. `s64` was the same defect still open when this was written: it asked
/// what had been ticked off "this week" and expected two rows finished the
/// previous Saturday, and it passed only because the reference answered that
/// one arm with a trailing seven days while answering `s01` with a calendar
/// week.
///
/// So: every request carrying a phrase from the published convention has each
/// of its expected rows checked against the window that phrase denotes. A row
/// outside it refuses the suite by name.
///
/// Three deliberate limits, each of which is a pass rather than a hidden fail:
///
/// * **A row with no date is not checked.** The inventory records a salient
///   date for rows that have one; a task with no due date has none, and a
///   completion stamp is not in the inventory at all. The count is printed so
///   the coverage is visible rather than assumed.
/// * **A bare "weekend" or "week" is accepted in EITHER direction.** Which
///   one a sentence means is decided by tense, and this validator does not
///   parse tense — `textref` does. Accepting both is the honest reading of
///   what this check can see.
/// * **Durations are not windows.** "about forty five minutes" denotes a
///   size, not a period, and nothing here pretends to check it.
///
/// The convention itself lives in [`calendar`] and is published in
/// `README.md`. It is the ONE deliberate exception to this binary being
/// standalone: a check that re-implemented the convention would be checking a
/// different convention, which is exactly the defect it exists to catch.
struct Temporal {
    phrases: usize,
    turns: usize,
    checked: usize,
    undated: usize,
}

/// The window a request denotes, and the phrase that said so.
///
/// `None` when the request names no period. The second window is present only
/// for a bare "weekend"/"week", where tense decides and this cannot read it.
fn window_of(today: &str, request: &str) -> Option<(String, Window, Option<Window>)> {
    let lower = request.to_lowercase();
    for phrase in calendar::phrases() {
        if lower.contains(phrase) {
            let window = calendar::phrase(today, phrase)?;
            return Some((phrase.to_owned(), window, None));
        }
    }
    if lower.contains("weekend") {
        return Some((
            "weekend (tense decides)".to_owned(),
            calendar::this_weekend(today),
            Some(calendar::last_weekend(today)),
        ));
    }
    if lower.contains(" week") {
        return Some((
            "week (tense decides)".to_owned(),
            calendar::this_week(today),
            Some(calendar::last_week(today)),
        ));
    }
    None
}

fn holds(first: &Window, second: Option<&Window>, stamp: &str) -> bool {
    first.holds(stamp) || second.is_some_and(|window| window.holds(stamp))
}

fn check_temporal(
    suite: &Suite,
    by_id: &BTreeMap<&str, &centraid_evalworld::Entity>,
    problems: &mut Vec<String>,
) -> Temporal {
    let mut found = Temporal {
        phrases: 0,
        turns: 0,
        checked: 0,
        undated: 0,
    };
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for session in &suite.sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            let at = format!("{}/turn {}", session.id, index + 1);
            let Some((phrase, window, alternative)) = window_of(&suite.today, &turn.request) else {
                continue;
            };
            found.turns += 1;
            seen.insert(phrase.clone());
            let span = |window: &Window, alternative: Option<&Window>| {
                alternative.map_or_else(
                    || format!("{}…{}", window.from, window.to),
                    |other| {
                        format!(
                            "{}…{} or {}…{}",
                            window.from, window.to, other.from, other.to
                        )
                    },
                )
            };
            match &turn.expected {
                Expected::Ids { ids, .. } => {
                    for id in ids {
                        let Some(row) = by_id.get(id.as_str()) else {
                            continue;
                        };
                        match row.date.as_deref() {
                            // A row the inventory gives no salient date is not
                            // evidence either way; counted, never guessed at.
                            None => found.undated += 1,
                            Some(date) => {
                                found.checked += 1;
                                if !holds(&window, alternative.as_ref(), date) {
                                    problems.push(format!(
                                        "{at}: the request says {phrase:?} ({}) and {id} \
                                         ({:?}) is dated {date} — the case asks one question \
                                         and expects the answer to another",
                                        span(&window, alternative.as_ref()),
                                        row.label
                                    ));
                                }
                            }
                        }
                    }
                }
                // A DATE A WRITE IS ASKED TO LAND ON. "push it to tomorrow"
                // with `to: 2026-06-18` is the same defect in write clothing.
                Expected::Write { args, .. } => {
                    check_temporal_args(&at, &phrase, &window, alternative.as_ref(), args, problems, &mut found);
                }
                Expected::WriteSet { writes, .. } => {
                    for step in writes {
                        check_temporal_args(
                            &at,
                            &phrase,
                            &window,
                            alternative.as_ref(),
                            &step.args,
                            problems,
                            &mut found,
                        );
                    }
                }
                Expected::Value { .. } | Expected::NoAction { .. } => {}
            }
        }
    }
    found.phrases = seen.len();
    found
}

fn check_temporal_args(
    at: &str,
    phrase: &str,
    window: &Window,
    alternative: Option<&Window>,
    args: &BTreeMap<String, serde_json::Value>,
    problems: &mut Vec<String>,
    found: &mut Temporal,
) {
    for key in ["to", "since", "on", "due"] {
        let Some(value) = args.get(key).and_then(serde_json::Value::as_str) else {
            continue;
        };
        if value.len() < 10 || !value.is_char_boundary(10) {
            continue;
        }
        found.checked += 1;
        if !holds(window, alternative, value) {
            problems.push(format!(
                "{at}: the request says {phrase:?} ({}…{}) and the write lands {key}={value}",
                window.from, window.to
            ));
        }
    }
}

/// **AN AGGREGATE THAT NOBODY CAN RECHECK IS A LITERAL WAITING TO GO STALE.**
///
/// 11 of the primary corpus's 12 `value` expectations were bare numbers when
/// this was written, against a world of 5,248 rows that another lane reseeds
/// whenever it adds a story row. The count was reported and the reporting
/// changed nothing, so it is a refusal now: a `value` turn carries a
/// `recompute`, or it is on this list with the reason no derivation can reach
/// it.
///
/// The list is deliberately awkward to add to. An entry is a statement that
/// the WORLD cannot describe the number, not that writing the block was dull.
const UNGUARDED_VALUE: &[(&str, &str)] = &[(
    "s67/turn 1",
    "what one member still owes is their share of every expense somebody else      paid for, less what everybody else owes them, less what they have already      settled — and `inventory.json` carries neither the per-expense splits nor      the settlement rows, so no description over it reaches the number. The fix      is in the WORLD (record `split:<party>` as an expense fact and settlements      as entities), not in a wider `Recompute`. DEFECTS.md #26.",
)];

/// Every `value` expectation is recomputed from the world, or excused by name.
fn check_every_value_is_guarded(suite: &Suite, problems: &mut Vec<String>) {
    let excused: BTreeSet<&str> = UNGUARDED_VALUE.iter().map(|&(at, _)| at).collect();
    let mut still_excused: BTreeSet<&str> = BTreeSet::new();
    for session in &suite.sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            let Expected::Value { recompute, .. } = &turn.expected else {
                continue;
            };
            let at = format!("{}/turn {}", session.id, index + 1);
            match (recompute.is_some(), excused.contains(at.as_str())) {
                (true, true) => problems.push(format!(
                    "{at}: carries a `recompute` AND sits on UNGUARDED_VALUE — take it off \
                     the list, an excuse that is not needed hides the next one that is"
                )),
                (false, false) => problems.push(format!(
                    "{at}: a `value` with no `recompute` — say how the number is derived \
                     from the world, or add it to UNGUARDED_VALUE with the reason no \
                     derivation reaches it"
                )),
                (false, true) => {
                    still_excused.insert("x");
                }
                (true, false) => {}
            }
        }
    }
    let _ = still_excused;
}

/// **TURNS WHOSE WORDS IMPLY AN ORDER THE CASE DOES NOT ASSERT** (review item
/// B9), as an advisory list rather than a refusal.
///
/// The mirror of the UNDECLARED ORDERING register: that one names cases that
/// assert a sequence without saying which sort it is, and this one names cases
/// whose request asks for "the next", "the latest", "what's due" and then
/// scores the answer as a SET. Both are the same defect from opposite sides —
/// the corpus and the request disagreeing about whether order is part of the
/// answer.
///
/// It is advisory because the fix is a corpus edit and the reading is a
/// judgement: "last week" is a window and not a superlative, and a turn
/// expecting one row cannot assert a sequence at all. The list is short enough
/// to be ruled on turn by turn, and DEFECTS.md carries the recommendations.
fn report_implied_ordering(suite: &Suite) -> Vec<(String, String, String, usize)> {
    /// Words that ask for a position in a sequence rather than a window. The
    /// two window phrases are excluded where they are windows: "next week"
    /// and "last week" name a period, not an nth row.
    const CUES: &[&str] = &[
        "next", "latest", "oldest", "first", "upcoming", "most recent", "soonest", "earliest",
        "coming up", "due",
    ];
    const WINDOWS: &[&str] = &[
        "next week", "last week", "next month", "last month", "next year", "next couple",
        "next few",
    ];
    let mut found = Vec::new();
    for session in &suite.sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            let Expected::Ids { ids, ordered, .. } = &turn.expected else {
                continue;
            };
            if *ordered {
                continue;
            }
            // A TURN EXPECTING ONE ROW CANNOT ASSERT A SEQUENCE. "Anything
            // overdue?" with a single expected id is a set of one, and
            // flagging it would bury the three turns where the question is
            // real.
            if ids.len() < 2 {
                continue;
            }
            let mut request = turn.request.to_lowercase();
            // "Overdue" is a STATE, not a position: it holds of a row on its
            // own, and no ordering follows from it.
            request = request.replace("overdue", " ");
            for window in WINDOWS {
                request = request.replace(window, " ");
            }
            let hit: Vec<&str> = CUES
                .iter()
                .filter(|cue| request.contains(**cue))
                .copied()
                .collect();
            if hit.is_empty() {
                continue;
            }
            found.push((
                format!("{}/t{}", session.id, index + 1),
                turn.request.clone(),
                hit.join(", "),
                ids.len(),
            ));
        }
    }
    found
}

/// **`--world N` — WHICH SEEDED WORLD THIS CORPUS IS WRITTEN AGAINST.**
///
/// `suite.json` and `blind.json` are corpora over world 1 and `holdout.json`
/// is a corpus over world 2 — a disjoint cast, places, weekend away and
/// collision structure, so that one of the three holds out the SCENARIO and
/// not only the wording. Everything this validator checks is the same for
/// both; what changes is which inventory the handles resolve against and which
/// world the untouched-world check deals.
///
/// Parsed out of the arguments wherever it appears, so the two positional
/// paths keep the places they have always had.
///
/// # Errors
///
/// A `--world` with nothing after it, or with something that is not 1 or 2.
fn world_switch() -> Result<(centraid_evalworld::Scenario, Vec<String>), String> {
    let mut world = centraid_evalworld::Scenario::First;
    let mut positional = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--world" | "--scenario" => {
                let which = args
                    .next()
                    .ok_or_else(|| "--world takes 1 or 2".to_owned())?;
                world = centraid_evalworld::Scenario::parse(&which)?;
            }
            _ => positional.push(argument),
        }
    }
    Ok((world, positional))
}
