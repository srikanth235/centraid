//! # `exec` — the executor
//!
//! A canonical tree ([`crate::canon`]) plus the session's [`State`] plus a
//! [`Context`] becomes a [`Plan`]. Every rule in
//! [`GRAMMAR.md`](../../../evalsuite/grammar/GRAMMAR.md) §4 is implemented
//! here and each is named by its rule number where it fires.
//!
//! **The only door is [`Context`].** There is no SQL, no session-id matching
//! and no corpus knowledge in this module: it is handed a tree and it executes
//! it. Whatever produces the tree — the oracle, or a model later — is scored on
//! the same executor.
//!
//! ## Recursion is a SEQUENCE, never a subquery
//!
//! The door's own statement grammar refuses subqueries, so a nested `Set` is
//! read first, its ids are collected, and the outer read binds them in code
//! (GRAMMAR.md §4). Concretely: each `Kind` node is one door read (a board, or
//! the FTS plane for an anchor), the ids come back, and the walk/filter above
//! it is a fold over those rows. Boards are cached FOR THE TURN — a second node
//! over the same door is the same read, and charging it twice would report a
//! round-trip count the door never saw. The cache is dropped at every write.

use std::collections::{BTreeMap, BTreeSet};

use centraid_evalsuite::reference::calendar;
use centraid_evalsuite::{App, Context, Plan, VaultRow};
use serde_json::{Value as Json, json};

use crate::canon::{ArgVal, Cmd, KindNode, Lit, Operand, Pred, Ref, Set, Turn, Value, Window};

// ---------------------------------------------------------------------------
// Declining
// ---------------------------------------------------------------------------

/// Why the executor stopped. The first three are the corpus's own outcome
/// vocabulary; `Unhandled` is this executor admitting it cannot do the turn,
/// and it is never dressed up as a polite question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    Clarify,
    Refuse,
    Nothing,
    Unhandled(String),
}

impl Stop {
    fn plan(&self) -> Plan {
        Plan::Declined {
            reason: match self {
                Self::Clarify => "clarify".to_owned(),
                Self::Refuse => "refuse".to_owned(),
                Self::Nothing => "none".to_owned(),
                Self::Unhandled(why) => format!("unhandled: {why}"),
            },
        }
    }
}

fn unhandled(why: impl Into<String>) -> Stop {
    Stop::Unhandled(why.into())
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

/// What a session remembers between turns (GRAMMAR.md §3).
#[derive(Debug, Default, Clone)]
pub struct State {
    /// The previous canonical, for the record; a rewrite arrives already
    /// rewritten, so nothing reads it except a human debugging a session.
    pub last_canonical: Option<Turn>,
    /// Every LIST answer this session gave, oldest first. `it`/`them` is the
    /// last; `the earlier one` is the one before it (GRAMMAR.md §3, s15.2).
    pub answers: Vec<Vec<VaultRow>>,
    /// Was the last list answer ordered? An ordinal into an unordered answer
    /// clarifies.
    pub ordered: bool,
    /// The last write, for `the last thing I added` and for an undo.
    pub last_write: Option<LastWrite>,
}

#[derive(Debug, Clone)]
pub struct LastWrite {
    pub command: String,
    pub rows: Vec<VaultRow>,
    /// What an undo command needs, when the write handed one back.
    pub revision_id: Option<String>,
}

impl State {
    /// The answer `back` turns before the last one. `back = 0` is `it`/`them`.
    fn held_at(&self, back: usize) -> &[VaultRow] {
        if self.answers.len() <= back {
            return &[];
        }
        &self.answers[self.answers.len() - 1 - back]
    }

    /// **R-X2, the transparency rule.** A `Value` turn does not replace the
    /// held rows, so only a list answer is pushed.
    fn remember(&mut self, rows: Vec<VaultRow>, ordered: bool) {
        self.answers.push(rows);
        self.ordered = ordered;
    }
}

// ---------------------------------------------------------------------------
// The doors, as this executor uses them
// ---------------------------------------------------------------------------

/// The seven FTS domains — `crates/search/src/domains.rs`. Locker is
/// structurally absent, on purpose.
const SEARCH_DOMAINS: [&str; 7] = [
    "knowledge.note",
    "core.party",
    "core.event",
    "schedule.task",
    "tally.expense",
    "core.content_item",
    "core.document",
];

fn app_of(door: &str) -> Option<App> {
    Some(match door {
        "agenda" => App::Agenda,
        "docs" => App::Docs,
        "locker" => App::Locker,
        "notes" => App::Notes,
        "people" => App::People,
        "photos" => App::Photos,
        "tally" => App::Tally,
        "tasks" => App::Tasks,
        _ => return None,
    })
}

/// Verbs whose EFFECT leaves the vault, whatever the registry holds.
///
/// R-R1 names "the verb is outside the command registry"; the registry test
/// alone would let `social.send_message` through, because it IS registered —
/// it records an outbound message while the member's request is for the
/// message to ARRIVE, and no seat in this product sends one. So the executor
/// reads the rule by its stated subject, the effect being outside the vault.
///
/// That subject is no longer a judgement made here. `CommandDefinition` grew
/// `DECLARED_EGRESS` (`crates/vault/src/commands/mod.rs`), the derivation
/// checks that every command a structural signal raises has been ruled on, and
/// `canon::egress_verbs()` is generated from it. The hand-written list this
/// replaced held ONE name and missed `locker.export`, which is R-R2's own
/// worked example ("bulk-export the locker").
fn egress(verb: &str) -> bool {
    crate::canon::egress_verbs().contains(&verb)
}

/// The destructive verb classes and commands, for R-C3 and R-R4.
fn destructive(verb: &str) -> bool {
    verb == "delete"
        || verb.contains("delete_")
        || verb.contains("trash_")
        || verb.contains("cancel_")
}

/// Verbs whose subject is ONE named person or ONE debt.
///
/// R-C1 in its sharpest form: "settle up with Neha" and "log a call with
/// Marco" name a person, and three rows called Marco is not a bulk write, it
/// is a question. A reschedule over two tasks IS a bulk write (R-W1), which is
/// why this is a list of verbs and not a rule about row counts.
const PARTY_SUBJECT: [&str; 4] = [
    "people.log_interaction",
    "people.settle_debt",
    "people.trash_person",
    "tally.add_group_member",
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

type Rows = Vec<VaultRow>;

/// One turn's caches: the boards read so far and the columns asked of the
/// field door.
#[derive(Default)]
struct Caches {
    boards: BTreeMap<String, Rows>,
    fields: BTreeMap<(String, String, String), Option<String>>,
    /// **A PROBE BUDGET.** `Context::field` is "look closer at this row"; a
    /// scan that asks it for a column the entity's table does not hold pays a
    /// door call per row and learns nothing. After this many misses for one
    /// (entity, column) the executor stops asking and reads the column as
    /// null, which is what the board already said.
    misses: BTreeMap<(String, String), usize>,
}

const PROBE_BUDGET: usize = 8;

struct Eval<'a, 'w> {
    ctx: &'a Context<'w>,
    caches: &'a mut Caches,
    state: &'a State,
    /// The tree asks about `deleted_at`, or the verb is a restore — so the
    /// trashed rows a board hands back are part of the answer.
    trashed: bool,
    /// Resolve a `called` anchor at the FTS door before the board.
    search_first: bool,
    /// **THE TOPIC BACKTRACK.** How many answers back `it`/`them` reaches.
    /// Zero for every turn; raised only when the last answer cannot be what
    /// the member meant — see [`run`].
    back: usize,
}

impl Eval<'_, '_> {
    fn board(&mut self, app: App) -> Rows {
        let key = app.id().to_owned();
        if let Some(found) = self.caches.boards.get(&key) {
            return found.clone();
        }
        let rows = self.ctx.open(app).unwrap_or_default();
        self.caches.boards.insert(key, rows.clone());
        rows
    }

    /// One column of one row: the extras the app's reader computed, the row's
    /// own label and salient date, and — for anything those do not carry — the
    /// field door.
    fn field(&mut self, row: &VaultRow, name: &str) -> Option<String> {
        if let Some(found) = row.extra.get(name) {
            return Some(found.clone());
        }
        // `deleted_at` is the liveness stamp the harness already read off the
        // row; asking the door again would answer the same thing twice.
        if name == "deleted_at" {
            let binned = !row.live || row.extra.get("trashed").map(String::as_str) == Some("true");
            if !binned {
                return None;
            }
            // WHEN it was binned, not just that it was: "did I bin anything in
            // the last few days" is a window over this stamp.
            return self.probe(row, name).or_else(|| Some("trashed".to_owned()));
        }
        if identity_field(&row.entity) == Some(name) {
            return Some(row.id.clone());
        }
        if name == "label" || label_field(&row.entity, name) {
            return Some(row.label.clone());
        }
        if date_field(&row.entity, name) {
            return row.date.clone();
        }
        self.probe(row, name)
    }

    /// The field door, under a probe budget.
    fn probe(&mut self, row: &VaultRow, name: &str) -> Option<String> {
        let key = (row.entity.clone(), row.id.clone(), name.to_owned());
        if let Some(found) = self.caches.fields.get(&key) {
            return found.clone();
        }
        let budget = (row.entity.clone(), name.to_owned());
        if self.caches.misses.get(&budget).copied().unwrap_or(0) >= PROBE_BUDGET {
            return None;
        }
        let found = self.ctx.field(&row.entity, &row.id, name).unwrap_or(None);
        if found.is_none() {
            *self.caches.misses.entry(budget).or_insert(0) += 1;
        }
        self.caches.fields.insert(key, found.clone());
        found
    }

    // -- kinds --------------------------------------------------------------

    fn kind_rows(&mut self, kind: &KindNode) -> Result<Rows, Stop> {
        if kind.kind == "things" {
            let mut all = Vec::new();
            for app in App::all() {
                all.extend(self.board(app));
            }
            // R-T1 — the union over the eight doors. A debt is one of the
            // things a member has about the dentist and it is not a board row,
            // so the People reader's own obligations join the fan-out.
            let parties: Vec<VaultRow> = all
                .iter()
                .filter(|row| row.entity == "core.party" && row.app == "people")
                .cloned()
                .collect();
            let mut ids = Vec::new();
            for party in &parties {
                ids.extend(self.obligations_of(party));
            }
            all.extend(self.obligation_rows(&ids));
            return Ok(self.liveness(all));
        }
        if kind.kind == "obligations" {
            let parties = self.board(App::People);
            let mut ids = Vec::new();
            for party in &parties {
                ids.extend(self.obligations_of(party));
            }
            return Ok(self.obligation_rows(&ids));
        }
        let Some(app) = app_of(&kind.door) else {
            return Err(unhandled(format!("no door for `{}`", kind.kind)));
        };
        let rows = self.board(app);
        let wanted = match kind.kind.as_str() {
            // The People journal is a `knowledge.note` the Notes library does
            // not hand back, and the roster's own notes are the journal's.
            "journal notes" => rows
                .into_iter()
                .filter(|row| row.entity == "knowledge.note")
                .collect(),
            // A profile's facts ride on the party row the roster answered.
            "profiles" => rows
                .into_iter()
                .filter(|row| row.entity == "core.party")
                .collect(),
            _ => rows
                .into_iter()
                .filter(|row| row.entity == kind.entity)
                .collect::<Rows>(),
        };
        Ok(self.liveness(wanted))
    }

    /// The trashed rows a board hands back are hidden unless the turn asked
    /// about them.
    fn liveness(&self, rows: Rows) -> Rows {
        if self.trashed {
            rows
        } else {
            rows.into_iter().filter(|row| row.live).collect()
        }
    }

    /// The open obligations People's own reader hung off a party.
    fn obligations_of(&mut self, party: &VaultRow) -> Vec<String> {
        let mut ids = Vec::new();
        for key in ["owed_to_them", "owed_to_me"] {
            if let Some(found) = party.extra.get(key) {
                ids.extend(
                    found
                        .split('\u{1f}')
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned),
                );
            }
        }
        ids
    }

    /// An obligation as a row. The People board carries only its id, so the
    /// columns come from the field door as they are asked for — its `reason`
    /// eagerly, because that is the label every other row already has and
    /// `called`/`contains` are asked of it.
    fn obligation_rows(&mut self, ids: &[String]) -> Rows {
        let mut seen = BTreeSet::new();
        let wanted: Vec<String> = ids
            .iter()
            .filter(|id| seen.insert((*id).clone()))
            .cloned()
            .collect();
        wanted
            .into_iter()
            .map(|id| {
                let mut row = VaultRow {
                    id,
                    entity: "tally.obligation".to_owned(),
                    app: "people".to_owned(),
                    label: String::new(),
                    date: None,
                    live: true,
                    extra: BTreeMap::new(),
                };
                row.label = self.field(&row, "reason").unwrap_or_default();
                row
            })
            .collect()
    }

    // -- sets ---------------------------------------------------------------

    fn set(&mut self, set: &Set) -> Result<Rows, Stop> {
        match set {
            Set::Kind(kind) => self.kind_rows(kind),
            Set::Walk { kind, from } => {
                let source = self.set(from)?;
                self.walk(kind, &source)
            }
            Set::Called { set, lit } => {
                let rows = self.called(set, lit)?;
                Ok(rows)
            }
            Set::Filter { set, pred } => {
                let rows = self.set(set)?;
                let mut kept = Vec::new();
                for row in rows {
                    if self.pred(&row, pred)? {
                        kept.push(row);
                    }
                }
                Ok(kept)
            }
            Set::During { set, window } => {
                let rows = self.set(set)?;
                // R-T2 — `things during Window` is the calendar, the board and
                // the birthday, and a completed task is not "on".
                let rows = if base_kind(set) == Some("things") {
                    let mut kept = Vec::new();
                    for row in rows {
                        let keep = match row.entity.as_str() {
                            "core.event" | "people.important_date" => true,
                            "schedule.task" => {
                                self.field(&row, "status").as_deref() != Some("completed")
                            }
                            _ => false,
                        };
                        if keep {
                            kept.push(row);
                        }
                    }
                    kept
                } else {
                    rows
                };
                let span = self.span(window)?;
                let mut kept = Vec::new();
                for row in rows {
                    let stamp = row.date.clone();
                    if stamp.as_deref().is_some_and(|stamp| span.holds(stamp)) {
                        kept.push(row);
                    }
                }
                Ok(kept)
            }
            Set::Order {
                set,
                field,
                descending,
            } => {
                let rows = self.set(set)?;
                Ok(self.sorted(rows, field, *descending))
            }
            Set::Union(left, right) => {
                let mut rows = self.set(left)?;
                let seen: BTreeSet<String> = rows.iter().map(|row| row.id.clone()).collect();
                for row in self.set(right)? {
                    if !seen.contains(&row.id) {
                        rows.push(row);
                    }
                }
                Ok(rows)
            }
            Set::Except(left, right) => {
                let rows = self.set(left)?;
                let drop: BTreeSet<String> =
                    self.set(right)?.into_iter().map(|row| row.id).collect();
                Ok(rows
                    .into_iter()
                    .filter(|row| !drop.contains(&row.id))
                    .collect())
            }
            Set::First { n, set } => {
                let rows = self.set(set)?;
                Ok(rows.into_iter().take(*n as usize).collect())
            }
            Set::Ref(found) => self.reference(found),
        }
    }

    /// `Set called Lit` — a LABEL match.
    ///
    /// The anchor of a bare Kind with an FTS domain is resolved at the search
    /// door first and the board second (GRAMMAR.md §4): the hits name the rows,
    /// the board carries the facts the predicates above will ask for. The
    /// label test is kept over the hits because `called` is a label match and
    /// the FTS plane also matches a body.
    fn called(&mut self, set: &Set, lit: &str) -> Result<Rows, Stop> {
        let rows = self.set(set)?;
        let matching: Rows = rows
            .iter()
            .filter(|row| labelled(&row.label, lit))
            .cloned()
            .collect();
        if !self.search_first {
            return Ok(matching);
        }
        let Set::Kind(kind) = set else {
            return Ok(matching);
        };
        if !SEARCH_DOMAINS.contains(&kind.entity.as_str()) {
            return Ok(matching);
        }
        let hits = self.ctx.search(&kind.entity, lit, 200).unwrap_or_default();
        let rank: BTreeMap<String, usize> = hits
            .into_iter()
            .enumerate()
            .map(|(at, row)| (row.id, at))
            .collect();
        // IN THE DOOR'S OWN RANK ORDER. Where several rows answer to one name,
        // the search plane's ranking is the only resolution the product has,
        // and dropping it would make "Ray" a coin toss.
        let mut narrowed: Rows = matching
            .iter()
            .filter(|row| rank.contains_key(&row.id))
            .cloned()
            .collect();
        narrowed.sort_by_key(|row| rank.get(&row.id).copied().unwrap_or(usize::MAX));
        // The board is the fallback the door rule names: an anchor the FTS
        // plane cannot reach (a bare first name, a hyphenated title) is still
        // a label the board holds.
        Ok(if narrowed.is_empty() {
            matching
        } else {
            narrowed
        })
    }

    /// `Kind of Set` — the link walk (§2.3). **R-C4**: an edge the ontology
    /// does not hold is a clarify, never an inferred join.
    fn walk(&mut self, kind: &KindNode, source: &[VaultRow]) -> Result<Rows, Stop> {
        let mut out: Rows = Vec::new();
        let mut seen = BTreeSet::new();
        let mut unrelated = false;
        for row in source {
            let step = match (kind.kind.as_str(), row.entity.as_str()) {
                // Tally: the group's ledger, and the ledger's group.
                ("expenses", "tally.group") => {
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| found.extra.get("group_id") == Some(&row.id))
                        .collect()
                }
                ("groups", "tally.expense") => {
                    let group = row.extra.get("group_id").cloned();
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| Some(&found.id) == group.as_ref())
                        .collect()
                }
                ("settlements", "tally.group") => {
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| found.extra.get("group_id") == Some(&row.id))
                        .collect()
                }
                ("members", "tally.group") => {
                    let members = joined(row.extra.get("member_party_ids"));
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| members.contains(&found.id))
                        .collect()
                }
                // People: the sub-rows a party carries.
                ("obligations", "core.party") => {
                    let ids = self.obligations_of(row);
                    self.obligation_rows(&ids)
                }
                ("parties" | "profiles", "core.party") => vec![row.clone()],
                ("important dates" | "contact channels" | "activities", "core.party") => {
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| found.extra.get("party_id") == Some(&row.id))
                        .collect()
                }
                ("parties", "tally.obligation") => {
                    let mut wanted = Vec::new();
                    for column in ["to_party", "from_party"] {
                        if let Some(found) = self.field(row, column)
                            && found != self.ctx.me()
                        {
                            wanted.push(found);
                        }
                    }
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| wanted.contains(&found.id))
                        .collect()
                }
                // Agenda: who an event names, and what names a person.
                ("parties", "core.event") => {
                    let attendees = joined(row.extra.get("attendee_party_ids"));
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| attendees.contains(&found.id))
                        .collect()
                }
                ("events", "core.party") => {
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| {
                            joined(found.extra.get("attendee_party_ids")).contains(&row.id)
                        })
                        .collect()
                }
                // Photos: the place a frame was taken, and the album it is in.
                ("photos", "core.place") => {
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| found.extra.get("place_id") == Some(&row.id))
                        .collect()
                }
                ("places", "core.content_item") => {
                    let place = row.extra.get("place_id").cloned();
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| Some(&found.id) == place.as_ref())
                        .collect()
                }
                ("photos", "media.album") => {
                    let title = row.label.clone();
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| joined(found.extra.get("album_titles")).contains(&title))
                        .collect()
                }
                ("albums", "core.content_item") => {
                    let titles = joined(row.extra.get("album_titles"));
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| titles.contains(&found.label))
                        .collect()
                }
                // Tasks: the self-referential edge.
                ("tasks", "schedule.task") => {
                    let all = self.kind_rows(kind)?;
                    all.into_iter()
                        .filter(|found| found.extra.get("parent_task_id") == Some(&row.id))
                        .collect()
                }
                // A walk onto the kind the row already is, reached through a
                // `Ref` — `photos of (them)` over a held photo set — is the
                // identity, not a missing edge.
                (_, _) if same_kind(kind, &row.entity) => vec![row.clone()],
                _ => {
                    unrelated = true;
                    Vec::new()
                }
            };
            for found in step {
                if seen.insert(found.id.clone()) {
                    out.push(found);
                }
            }
        }
        // **A ROW THAT NAMES A PARTY STANDS FOR THAT PARTY.** The vault holds
        // no edge from a phone number to a diary, but it holds both edges
        // through the person, so "and when am I seeing her?" after "what's her
        // number" is one hop each way. This is not an inferred edge (R-C4):
        // both legs are real foreign keys.
        //
        // Over SEVERAL source rows the bridge takes the parties common to all
        // of them: "what's in the diary with Ana Ferreira" answered three
        // events, and the person those three are about is the one they share.
        if out.is_empty() && unrelated && source.iter().all(|row| !party_ids(row).is_empty()) {
            let mut common: Option<BTreeSet<String>> = None;
            for row in source {
                let here: BTreeSet<String> = party_ids(row).into_iter().collect();
                common = Some(match common {
                    Some(so_far) => so_far.intersection(&here).cloned().collect(),
                    None => here,
                });
            }
            let wanted = common.unwrap_or_default();
            let bridge: Rows = self
                .board(App::People)
                .into_iter()
                .filter(|found| found.entity == "core.party" && wanted.contains(&found.id))
                .collect();
            if !bridge.is_empty() {
                return self.walk(kind, &bridge);
            }
        }
        // R-C4 — nothing in the ontology joins these two entities.
        //
        // And, one step further: a walk from rows the session HOLDS that
        // reaches nothing is also a clarify, not an empty list. "Which Neha is
        // that?" over a dinner whose summary names nobody is the vault being
        // unable to tell, exactly as in §1.1 — answering "none" would assert
        // the one fact the question asked for.
        if out.is_empty() && !source.is_empty() {
            return Err(Stop::Clarify);
        }
        Ok(out)
    }

    /// The context terminals (§3). **R-C5** — nothing to resolve is a clarify.
    fn reference(&mut self, found: &Ref) -> Result<Rows, Stop> {
        let held = self.state.held_at(self.back).to_vec();
        let rows = match found {
            // **`it` IS SINGULAR.** Where the held answer is a list and the
            // session has just written to one row of it, "star it" means that
            // row — the member is still talking about the thing they moved,
            // not about the list they read on the way past. `them` is the
            // plural and never narrows.
            Ref::It if held.len() > 1 => match self.state.last_write.as_ref() {
                Some(write)
                    if write.rows.len() == 1
                        && held.iter().any(|row| row.id == write.rows[0].id) =>
                {
                    write.rows.clone()
                }
                _ => held,
            },
            Ref::It | Ref::Them => held,
            Ref::ThatOne => {
                if held.len() == 1 {
                    held
                } else {
                    return Err(Stop::Clarify);
                }
            }
            Ref::TheOtherOne => {
                if held.len() == 2 {
                    vec![held[1].clone()]
                } else {
                    return Err(Stop::Clarify);
                }
            }
            Ref::TheEarlierOne => self.state.held_at(self.back + 1).to_vec(),
            Ref::LastAdded => match &self.state.last_write {
                Some(write) => write.rows.clone(),
                None => return Err(Stop::Clarify),
            },
            Ref::Ordinal(n) => {
                // §3 says an ordinal into an unordered answer clarifies. Every
                // answer this executor gives HAS an order — the board's, or an
                // explicit `ordered by` — and the corpus indexes that delivered
                // order (s111.3 ticks "the first one" off a filtered list with
                // no sort of its own). So the ordinal indexes the answer as it
                // was given. See the report's grammar-clarification list.
                match held.get((*n as usize).saturating_sub(1)) {
                    Some(row) => vec![row.clone()],
                    None => return Err(Stop::Clarify),
                }
            }
        };
        if rows.is_empty() {
            return Err(Stop::Clarify);
        }
        Ok(self.refreshed(rows))
    }

    /// **A HELD ROW IS AN ID, NOT A SNAPSHOT.** "What's left of them" after a
    /// task was ticked off must read the status the write left behind, so the
    /// held rows are re-read from their own door before they are filtered.
    fn refreshed(&mut self, rows: Rows) -> Rows {
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(app) = app_of(&row.app) else {
                out.push(row);
                continue;
            };
            let fresh = self
                .board(app)
                .into_iter()
                .find(|found| found.id == row.id && found.entity == row.entity);
            out.push(fresh.unwrap_or(row));
        }
        out
    }

    fn sorted(&mut self, mut rows: Rows, field: &str, descending: bool) -> Rows {
        let mut keyed: Vec<(Option<String>, VaultRow)> = rows
            .drain(..)
            .map(|row| (self.field(&row, field), row))
            .collect();
        keyed.sort_by(|left, right| {
            let order = match (
                left.0.as_deref().and_then(as_number),
                right.0.as_deref().and_then(as_number),
            ) {
                (Some(a), Some(b)) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
                _ => left.0.cmp(&right.0),
            };
            if descending { order.reverse() } else { order }
        });
        keyed.into_iter().map(|(_, row)| row).collect()
    }

    // -- predicates ---------------------------------------------------------

    fn pred(&mut self, row: &VaultRow, pred: &Pred) -> Result<bool, Stop> {
        Ok(match pred {
            Pred::And(left, right) => self.pred(row, left)? && self.pred(row, right)?,
            Pred::Or(left, right) => self.pred(row, left)? || self.pred(row, right)?,
            Pred::Not(inner) => !self.pred(row, inner)?,
            // `count of Kind Cmp Num` — the COUNT OVER THE WALK from this
            // row (§2.4). The walk is the ontology's edge and it is taken
            // from the single row being filtered, which is what makes the
            // predicate correlated without a correlated terminal.
            Pred::CountWalk { kind, op, n } => {
                let reached = match self.walk(kind, std::slice::from_ref(row)) {
                    Ok(rows) => rows.len() as i64,
                    // R-C4 is about a walk the ONTOLOGY does not hold; a row
                    // that simply reaches nothing counts zero.
                    Err(_) => 0,
                };
                match op.as_str() {
                    "=" => reached == *n,
                    "!=" => reached != *n,
                    "<" => reached < *n,
                    "<=" => reached <= *n,
                    ">" => reached > *n,
                    ">=" => reached >= *n,
                    _ => return Err(unhandled("unknown comparison in `count of`")),
                }
            }
            Pred::Member(set) => {
                let others = self.set(set)?;
                // The join table, read either way: a row is a member of a set
                // when it IS one of them, or when the link table that relates
                // the two kinds holds the pair. "Which albums hold
                // photographs" is the second reading and has no id in common
                // with the first at all.
                others
                    .iter()
                    .any(|other| other.id == row.id || linked(row, other))
            }
            Pred::Is {
                field,
                what,
                negated,
            } => {
                let found = self.field(row, field);
                let holds = match what.as_str() {
                    "null" => found.as_deref().is_none_or(str::is_empty),
                    _ => found.as_deref() == Some(self.ctx.me()),
                };
                holds != *negated
            }
            Pred::During { field, window } => {
                let span = self.span(window)?;
                self.field(row, field)
                    .as_deref()
                    .is_some_and(|stamp| span.holds(stamp))
            }
            Pred::Band { field, centre } => {
                let centre: f64 = centre.parse().unwrap_or(0.0);
                // §2.4 — half again either way.
                self.field(row, field)
                    .as_deref()
                    .and_then(as_number)
                    .is_some_and(|value| value >= centre / 1.5 && value <= centre * 1.5)
            }
            Pred::Contains { field, lit } => self
                .field(row, field)
                .is_some_and(|value| value.to_lowercase().contains(&lit.to_lowercase())),
            Pred::OneOf { field, lits } => self
                .field(row, field)
                .is_some_and(|value| lits.contains(&value)),
            Pred::Cmp { field, op, rhs } => {
                let left = self.field(row, field);
                match rhs {
                    Operand::SetArg(set) => {
                        let ids: BTreeSet<String> =
                            self.set(set)?.into_iter().map(|row| row.id).collect();
                        let held = left.is_some_and(|value| ids.contains(&value));
                        if op == "!=" { !held } else { held }
                    }
                    Operand::FieldRef(other) => {
                        let right = self.field(row, other);
                        compare(left.as_deref(), op, right.as_deref())
                    }
                    Operand::Lit(lit) => {
                        let right = self.literal(lit);
                        compare(left.as_deref(), op, right.as_deref())
                    }
                }
            }
        })
    }

    /// A literal as the string a column would hold. `me` is the member's own
    /// party id.
    fn literal(&self, lit: &Lit) -> Option<String> {
        Some(match (lit.ty.as_str(), lit.value.as_str()) {
            ("keyword", "me") => self.ctx.me().to_owned(),
            ("keyword", "null") => return None,
            _ => lit.value.clone(),
        })
    }

    // -- windows ------------------------------------------------------------

    fn span(&mut self, window: &Window) -> Result<Span, Stop> {
        Ok(match window {
            Window::Phrase(phrase) if phrase == "before now" => {
                Span::BeforeNow(self.ctx.now().to_owned())
            }
            Window::Phrase(phrase) => match calendar::phrase(self.ctx.today(), phrase) {
                Some(found) => Span::Days(found.from, found.to),
                None => return Err(unhandled(format!("no window for `{phrase}`"))),
            },
            Window::Stamp { how, value } => match how.as_str() {
                "date" => Span::Days(value.clone(), value.clone()),
                "datetime" => Span::Days(value[..10].to_owned(), value[..10].to_owned()),
                "month" => {
                    let first = format!("{value}-01");
                    let last = calendar::shift(&calendar::months_ahead(&first, 1), -1);
                    Span::Days(first, last)
                }
                "daterange" => Span::Days(value[..10].to_owned(), value[12..22].to_owned()),
                _ => return Err(unhandled("unknown window stamp")),
            },
            Window::Rolling { n, unit } => {
                let today = self.ctx.today().to_owned();
                let end = match unit.as_str() {
                    "days" => calendar::shift(&today, *n),
                    "weeks" => calendar::shift(&today, n * 7),
                    _ => calendar::months_ahead(&today, *n),
                };
                Span::Days(today, end)
            }
            // §2.6 — the ANCHORED window, whose ends the vault itself holds.
            Window::Anchored { from, to } => {
                let start = self.one_value(from)?;
                let end = self.one_value(to)?;
                if start.len() < 10 || end.len() < 10 {
                    return Err(Stop::Clarify);
                }
                Span::Days(start[..10].to_owned(), end[..10].to_owned())
            }
        })
    }

    /// A `Value` whose answer is a STRING — an anchored window's end, a
    /// command argument's date. **R-C1**: the set must resolve to exactly one
    /// row.
    fn one_value(&mut self, value: &Value) -> Result<String, Stop> {
        match value {
            Value::Project { field, set } => {
                let rows = self.set(set)?;
                self.agreed(&rows, field)
            }
            // `min`/`max` over a DATE column — an anchored window's own ends
            // (§2.6) are stamps, not numbers, so they are folded as strings.
            Value::Agg {
                agg,
                field: Some(field),
                set,
            } if agg == "min" || agg == "max" => {
                let rows = self.set(set)?;
                let mut found: Vec<String> = rows
                    .iter()
                    .filter_map(|row| self.field(row, field))
                    .collect();
                found.sort();
                let picked = if agg == "min" {
                    found.first()
                } else {
                    found.last()
                };
                picked.cloned().ok_or(Stop::Clarify)
            }
            _ => {
                let number = self.number(value)?;
                Ok(format!("{number}"))
            }
        }
    }

    /// **R-C1, read as the rule says.** One row is needed where the ANSWER
    /// would otherwise be ambiguous; several rows that all hold the same value
    /// are not ambiguous, and "how often am I supposed to call Ray" over nine
    /// Rays who share a cadence has one answer, not a question.
    fn agreed(&mut self, rows: &[VaultRow], field: &str) -> Result<String, Stop> {
        let mut values: Vec<String> = rows
            .iter()
            .filter_map(|row| self.field(row, field))
            .collect();
        values.sort();
        values.dedup();
        match values.len() {
            0 => Err(Stop::Clarify),
            1 => Ok(values.remove(0)),
            // Several rows that DISAGREE: the answer is the best-matching
            // row's, because `called` is a ranked retrieval and the door's own
            // rank is the resolution it offers. R-C1 asks for one row where one
            // is needed; the ranking is how one is got. See the report.
            _ => rows
                .first()
                .and_then(|row| self.field(row, field))
                .ok_or(Stop::Clarify),
        }
    }

    /// A `Value` whose answer is a NUMBER.
    fn number(&mut self, value: &Value) -> Result<f64, Stop> {
        match value {
            Value::Agg { agg, field, set } => {
                self.definite(set)?;
                let rows = self.set(set)?;
                // R-C2 — a `Value` over `things` that spans Kinds is a
                // clarify, not an arithmetic over apples and diaries.
                if base_kind(set) == Some("things") && spans_kinds(&rows) {
                    return Err(Stop::Clarify);
                }
                if agg == "count" {
                    #[expect(clippy::cast_precision_loss, reason = "a row count")]
                    let count = rows.len() as f64;
                    return Ok(count);
                }
                let Some(field) = field else {
                    return Err(unhandled("an aggregate with no field"));
                };
                let values: Vec<f64> = rows
                    .iter()
                    .filter_map(|row| self.field(row, field))
                    .filter_map(|found| as_number(&found))
                    .collect();
                Ok(match agg.as_str() {
                    "sum" => values.iter().sum(),
                    "min" => values.iter().copied().fold(f64::INFINITY, f64::min),
                    _ => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                })
            }
            Value::Project { field, set } => {
                let rows = self.set(set)?;
                if base_kind(set) == Some("things") && spans_kinds(&rows) {
                    return Err(Stop::Clarify);
                }
                self.agreed(&rows, field)?
                    .parse::<f64>()
                    .map_err(|_| Stop::Clarify)
            }
            Value::Balance { of, within } => {
                let who = self.set(of)?;
                let group = self.set(within)?;
                if group.len() != 1 {
                    return Err(Stop::Clarify);
                }
                // A balance IN a group is a balance of one of its members, so
                // the roster is what narrows an anchor that matched several —
                // not a guess, the `in` clause the canonical already carries.
                let members = joined(group[0].extra.get("member_party_ids"));
                let who: Rows = if who.len() > 1 {
                    who.into_iter()
                        .filter(|row| members.contains(&row.id))
                        .collect()
                } else {
                    who
                };
                if who.len() != 1 {
                    return Err(Stop::Clarify);
                }
                self.balance(&who[0].id, &group[0].id)
            }
        }
    }

    /// **R-C1 over a walk out of a BARE kind.** "What did I spend in the
    /// group" when there are two groups is a question, not a sum: the member
    /// said *the* group and the canonical's walk source names none of them.
    /// A source that is bounded (`called`, `that`, a window) or a `Ref` is the
    /// member having said which, and several rows there is a legitimate fold.
    fn definite(&mut self, set: &Set) -> Result<(), Stop> {
        if let Set::Walk { from, .. } = set
            && matches!(**from, Set::Kind(_))
            && self.set(from)?.len() > 1
        {
            return Err(Stop::Clarify);
        }
        match set {
            Set::Called { set, .. }
            | Set::Filter { set, .. }
            | Set::During { set, .. }
            | Set::Order { set, .. }
            | Set::First { set, .. } => self.definite(set),
            _ => Ok(()),
        }
    }

    /// `balance of Set in Set` — Tally's signed fold, over the shares its own
    /// reader computed (§2.5). **Positive means this party OWES**, which is
    /// the direction the member's question runs ("how much does Marco owe me
    /// for the trip") and the direction `tally.settle_up` is written in.
    fn balance(&mut self, party: &str, group: &str) -> Result<f64, Stop> {
        let rows = self.board(App::Tally);
        let mut net = 0.0f64;
        for row in &rows {
            match row.entity.as_str() {
                "tally.expense" if row.extra.get("group_id").map(String::as_str) == Some(group) => {
                    if !row.live || row.extra.contains_key("deleted") {
                        continue;
                    }
                    if row.extra.get("paid_by").map(String::as_str) == Some(party) {
                        net -= row
                            .extra
                            .get("amount_minor")
                            .and_then(|found| as_number(found))
                            .unwrap_or(0.0);
                    }
                    if let Some(share) = row.extra.get(&format!("split:{party}")) {
                        net += as_number(share).unwrap_or(0.0);
                    }
                }
                "tally.settlement"
                    if row.extra.get("group_id").map(String::as_str) == Some(group) =>
                {
                    let amount = row
                        .extra
                        .get("amount_minor")
                        .and_then(|found| as_number(found))
                        .unwrap_or(0.0);
                    if row.extra.get("from_party").map(String::as_str) == Some(party) {
                        net -= amount;
                    }
                    if row.extra.get("to_party").map(String::as_str) == Some(party) {
                        net += amount;
                    }
                }
                _ => {}
            }
        }
        Ok(net)
    }
}

/// An inclusive day window, or the overdue comparison.
enum Span {
    Days(String, String),
    BeforeNow(String),
}

impl Span {
    fn holds(&self, stamp: &str) -> bool {
        match self {
            Self::Days(from, to) => {
                stamp.len() >= 10 && &stamp[..10] >= from.as_str() && &stamp[..10] <= to.as_str()
            }
            Self::BeforeNow(now) => stamp < now.as_str(),
        }
    }
}

/// Does this label answer to `called Lit`?
///
/// The literal as a substring, or — because a member says "my dentist
/// cleaning" and the calendar says "Dentist — cleaning" — every word of it
/// present in the label. The second is what the FTS plane would answer for the
/// same phrase, said in the board's own terms so a row's facts come with it.
fn labelled(label: &str, lit: &str) -> bool {
    let label = label.to_lowercase();
    let needle = lit.to_lowercase();
    if label.contains(&needle) {
        return true;
    }
    let words: Vec<&str> = needle.split_whitespace().collect();
    !words.is_empty() && words.iter().all(|word| label.contains(word))
}

fn joined(found: Option<&String>) -> Vec<String> {
    found.map_or_else(Vec::new, |value| {
        value
            .split('\u{1f}')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect()
    })
}

fn as_number(raw: &str) -> Option<f64> {
    raw.parse::<f64>().ok()
}

fn compare(left: Option<&str>, op: &str, right: Option<&str>) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
        // A comparison against a missing value is false, except `!=`, where a
        // row that holds nothing is not equal to something.
        return op == "!=" && left != right;
    };
    let order = match (as_number(left), as_number(right)) {
        (Some(a), Some(b)) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
        _ => left.cmp(right),
    };
    match op {
        "=" => order.is_eq(),
        "!=" => !order.is_eq(),
        "<" => order.is_lt(),
        "<=" => order.is_le(),
        ">" => order.is_gt(),
        _ => order.is_ge(),
    }
}

/// The Kind at the bottom of a `Set` expression.
fn base_kind(set: &Set) -> Option<&str> {
    match set {
        Set::Kind(kind) | Set::Walk { kind, .. } => Some(&kind.kind),
        Set::Called { set, .. }
        | Set::Filter { set, .. }
        | Set::During { set, .. }
        | Set::Order { set, .. }
        | Set::First { set, .. } => base_kind(set),
        Set::Union(left, _) | Set::Except(left, _) => base_kind(left),
        Set::Ref(_) => None,
    }
}

/// Does the join table that relates these two rows hold this pair?
fn linked(row: &VaultRow, other: &VaultRow) -> bool {
    match (row.entity.as_str(), other.entity.as_str()) {
        ("media.album", "core.content_item") => {
            joined(other.extra.get("album_titles")).contains(&row.label)
        }
        ("core.content_item", "media.album") => {
            joined(row.extra.get("album_titles")).contains(&other.label)
        }
        ("tally.group", "core.party") => {
            joined(row.extra.get("member_party_ids")).contains(&other.id)
        }
        ("core.party", "tally.group") => {
            joined(other.extra.get("member_party_ids")).contains(&row.id)
        }
        _ => false,
    }
}

/// The parties a row names — its own party column, or an event's attendees.
fn party_ids(row: &VaultRow) -> Vec<String> {
    if row.entity == "core.party" {
        return Vec::new();
    }
    let mut ids = joined(row.extra.get("attendee_party_ids"));
    if let Some(found) = row.extra.get("party_id") {
        ids.push(found.clone());
    }
    ids
}

fn spans_kinds(rows: &[VaultRow]) -> bool {
    rows.iter()
        .map(|row| &row.entity)
        .collect::<BTreeSet<_>>()
        .len()
        > 1
}

fn same_kind(kind: &KindNode, entity: &str) -> bool {
    kind.entity == entity
}

fn identity_field(entity: &str) -> Option<&'static str> {
    Some(match entity {
        "core.event" => "event_id",
        "schedule.task" => "task_id",
        "knowledge.note" => "note_id",
        "core.document" => "document_id",
        "core.party" => "party_id",
        "people.important_date" => "date_id",
        "social.contact_channel" => "channel_id",
        "core.activity" => "activity_id",
        "core.content_item" => "asset_id",
        "media.album" => "album_id",
        "core.place" => "place_id",
        "tally.expense" => "expense_id",
        "tally.group" => "group_id",
        "tally.settlement" => "settlement_id",
        "tally.obligation" => "obligation_id",
        "locker.item" => "item_id",
        // The Kinds beyond the original nineteen, each declared
        // `surface: "kind"` on exactly one door's manifest.
        // A notebook is a `core_collection` row, so its id column is the
        // collection's — the Notes door renames the THING, not the column.
        "knowledge.notebook" => "collection_id",
        "social.circle" => "circle_id",
        "schedule.project" => "project_id",
        "core.account" => "account_id",
        "core.transaction" => "txn_id",
        _ => return None,
    })
}

/// Is this field the row's LABEL, as the door that answered it spelled one?
fn label_field(entity: &str, field: &str) -> bool {
    match entity {
        "core.event" => field == "summary",
        "schedule.task" | "core.document" | "knowledge.note" | "core.content_item" => {
            field == "title"
        }
        "core.party" => matches!(field, "display_name" | "sort_name" | "name"),
        "core.place" | "tally.group" => field == "name",
        "knowledge.notebook" | "social.circle" | "schedule.project" | "core.account" => {
            field == "name"
        }
        "core.transaction" => field == "description",
        "media.album" => field == "title",
        "locker.item" => field == "title",
        "tally.expense" => field == "description",
        _ => false,
    }
}

/// Is this field the row's SALIENT DATE, as the board stamped it?
fn date_field(entity: &str, field: &str) -> bool {
    match entity {
        "core.event" => field == "dtstart",
        "schedule.task" => field == "due_at",
        "knowledge.note" => matches!(field, "updated_at" | "created_at"),
        "core.document" => matches!(field, "updated_at" | "created_at"),
        "core.content_item" => field == "captured_at",
        "tally.expense" => field == "spent_on",
        "tally.settlement" => field == "paid_on",
        "core.activity" => field == "started_at",
        "people.important_date" => field == "next_occurrence",
        "core.transaction" => field == "posted_at",
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/// Execute one canonical tree.
///
/// Reads first, then writes: the whole read phase runs against an immutable
/// `Context` (so the boards can be cached and shared), and only a `Cmd`'s
/// commands take it mutably.
pub fn execute(tree: &Turn, state: &mut State, ctx: &mut Context<'_>) -> Plan {
    let plan = run(tree, state, ctx);
    state.last_canonical = Some(tree.clone());
    plan
}

fn run(tree: &Turn, state: &mut State, ctx: &mut Context<'_>) -> Plan {
    let trashed = mentions_trash(tree);
    let mut caches = Caches::default();
    match tree {
        Turn::Nothing => Stop::Nothing.plan(),
        Turn::Refuse(_) => Stop::Refuse.plan(),
        Turn::Clarify(_) => Stop::Clarify.plan(),
        Turn::Show(set) => {
            // **THE TOPIC BACKTRACK.** "Hang on — what's on tomorrow?" and
            // then "back to the money — which of those two…": `them` is not
            // the detour's answer, it is the thread the member returned to.
            // An empty answer over a `Ref` is the signal, because a member who
            // says "those two" is not asking about nothing. §3 has no move for
            // this and the corpus needs one — see the report.
            let mut answer = Err(Stop::Clarify);
            for back in 0..3 {
                let mut eval = evaluator(ctx, &mut caches, state, trashed);
                eval.back = back;
                answer = eval.set(set);
                match &answer {
                    Ok(rows) if rows.is_empty() && mentions_ref(set) => {}
                    _ => break,
                }
                if state.answers.len() <= back + 1 {
                    break;
                }
            }
            match answer {
                Ok(rows) => {
                    let ids = rows.iter().map(|row| row.id.clone()).collect();
                    let ordered = is_ordered(set);
                    state.remember(rows, ordered);
                    Plan::Ids(ids)
                }
                Err(stop) => stop.plan(),
            }
        }
        Turn::Same(left, right) => {
            let mut eval = evaluator(ctx, &mut caches, state, trashed);
            let (Ok(left), Ok(right)) = (eval.set(left), eval.set(right)) else {
                return Stop::Clarify.plan();
            };
            // §1.1 — an intersection over sets of UNRELATED KINDS is a
            // clarify, never a `no`: the vault cannot tell, and `no` would
            // invent the one fact the question asked for.
            let kinds: BTreeSet<&String> = left
                .iter()
                .chain(right.iter())
                .map(|row| &row.entity)
                .collect();
            let ids: BTreeSet<&String> = left.iter().map(|row| &row.id).collect();
            let shared: Vec<String> = right
                .iter()
                .filter(|row| ids.contains(&row.id))
                .map(|row| row.id.clone())
                .collect();
            if shared.is_empty() && kinds.len() > 1 {
                return Stop::Clarify.plan();
            }
            Plan::Ids(shared)
        }
        Turn::Value(value) => {
            let mut eval = evaluator(ctx, &mut caches, state, trashed);
            let answer = eval.number(value);
            // **R-X2 SAYS A VALUE DOES NOT REPLACE THE HELD ROWS — it does not
            // say a session that has only ever asked for numbers holds none.**
            // "What have we spent on the trip?" / "how much of that did I pay
            // for myself?" is a refinement over the rows the first turn
            // folded, and there is nothing else for `them` to mean.
            if answer.is_ok() && state.answers.is_empty() {
                let rows = value_rows(value)
                    .and_then(|set| {
                        let mut eval = evaluator(ctx, &mut caches, state, trashed);
                        eval.set(set).ok()
                    })
                    .unwrap_or_default();
                if !rows.is_empty() {
                    state.remember(rows, false);
                }
            }
            match answer {
                Ok(number) => Plan::Value(number),
                Err(stop) => stop.plan(),
            }
        }
        Turn::Cmd(cmd) => command(cmd, state, ctx, &mut caches, trashed),
        // `Cmd then Cmd` — the ordered sequence. Every step must land: a half
        // finished sequence is worse than none, because the member believes
        // it finished (R-W1, one layer up). The first step that declines is
        // the turn's outcome.
        Turn::Seq(steps) => {
            let mut last = Plan::Wrote;
            for step in steps {
                last = command(step, state, ctx, &mut caches, trashed);
                if !matches!(last, Plan::Wrote) {
                    return last;
                }
            }
            last
        }
    }
}

fn evaluator<'a, 'w>(
    ctx: &'a Context<'w>,
    caches: &'a mut Caches,
    state: &'a State,
    trashed: bool,
) -> Eval<'a, 'w> {
    Eval {
        ctx,
        caches,
        state,
        trashed,
        search_first: std::env::var_os("CANDIDATES_NO_SEARCH").is_none(),
        back: 0,
    }
}

/// Does the turn ask about the trash?
fn mentions_trash(tree: &Turn) -> bool {
    let printed = tree.to_canonical();
    printed.contains("deleted_at")
        || printed.contains("restore")
        || printed.contains("undo_")
        || printed.contains("archived_at")
}

/// The rows a `Value` folded.
fn value_rows(value: &Value) -> Option<&Set> {
    match value {
        Value::Agg { set, .. } | Value::Project { set, .. } => Some(set),
        Value::Balance { .. } => None,
    }
}

/// Does this set reach into the conversation at all?
fn mentions_ref(set: &Set) -> bool {
    set.to_canonical().contains("it")
        || set.to_canonical().contains("them")
        || set.to_canonical().contains("one")
}

fn is_ordered(set: &Set) -> bool {
    match set {
        Set::Order { .. } => true,
        Set::First { set, .. }
        | Set::Called { set, .. }
        | Set::Filter { set, .. }
        | Set::During { set, .. } => is_ordered(set),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn command(
    cmd: &Cmd,
    state: &mut State,
    ctx: &mut Context<'_>,
    caches: &mut Caches,
    trashed: bool,
) -> Plan {
    // R-R1/R-R2 — a verb whose effect is outside the vault, or moves sealed
    // material out of custody.
    if egress(&cmd.verb) {
        return Stop::Refuse.plan();
    }
    let mut anchors: Rows = Vec::new();
    if let Some(on) = &cmd.on {
        // R-T1 — `things` is a legitimate list and NEVER a command anchor:
        // "the cabin booking" is a task AND an event and the member must say
        // which (R-C3 for a destructive verb, R-C1 for the rest).
        if base_kind(on) == Some("things") {
            return Stop::Clarify.plan();
        }
        // R-R4 — a destructive verb over an UNBOUNDED set. There is nothing to
        // ask about "delete every note in the vault"; the answer is no.
        if destructive(&cmd.verb) && !bounded(on) {
            return Stop::Refuse.plan();
        }
        let mut eval = evaluator(ctx, caches, state, trashed);
        anchors = match eval.set(on) {
            Ok(rows) => rows,
            Err(stop) => return stop.plan(),
        };
        // R-C1, sharpened: a verb whose subject is ONE named person.
        if PARTY_SUBJECT.contains(&cmd.verb.as_str()) {
            let subject = subject_set(on);
            let mut eval = evaluator(ctx, caches, state, trashed);
            let people = match subject.map(|set| eval.set(set)) {
                Some(Ok(rows)) => rows.len(),
                Some(Err(stop)) => return stop.plan(),
                None => anchors.len(),
            };
            if people != 1 {
                return Stop::Clarify.plan();
            }
        }
        if anchors.is_empty() {
            // R-N1 — the anchor is in the trash: there is nothing to do and
            // nothing to ask.
            let mut eval = evaluator(ctx, caches, state, true);
            let trashed_match = eval.set(on).map(|rows| !rows.is_empty()).unwrap_or(false);
            return if trashed_match {
                Stop::Nothing.plan()
            } else {
                Stop::Clarify.plan()
            };
        }
        // R-C3 — a destructive verb class over an anchor that spans Kinds.
        if destructive(&cmd.verb) && spans_kinds(&anchors) {
            return Stop::Clarify.plan();
        }
    }
    // The bodies are built with the doors still readable, and only then
    // executed: R-W2 binds `it` inside `Args` to the anchor row being written.
    let mut bodies: Vec<(String, Json)> = Vec::new();
    if cmd.on.is_none() {
        let mut eval = evaluator(ctx, caches, state, trashed);
        match body(cmd, None, &mut eval, state) {
            Ok(built) => bodies.push(built),
            Err(stop) => return stop.plan(),
        }
    } else {
        for anchor in &anchors {
            let mut eval = evaluator(ctx, caches, state, trashed);
            match body(cmd, Some(anchor), &mut eval, state) {
                Ok(built) => bodies.push(built),
                Err(stop) => return stop.plan(),
            }
        }
    }
    let restoring = cmd.verb.contains("restore") || cmd.verb.contains("undo_");
    let mut revision = None;
    for (name, body) in bodies {
        match ctx.write(&name, body) {
            Ok(answer) => {
                if revision.is_none() {
                    revision = answer
                        .get("revision_id")
                        .and_then(Json::as_str)
                        .map(str::to_owned);
                }
            }
            // A restore the vault refuses is a REFUSAL and not a shrug: the
            // grace window has run out and saying it was done would be worse.
            Err(why) => {
                return if restoring {
                    Stop::Refuse.plan()
                } else {
                    unhandled(format!("{name}: {why}")).plan()
                };
            }
        }
    }
    // The `act` move (§3) wraps a command around the previous answer and does
    // not change what `it` means — and where the command IS the first turn, the
    // rows it wrote are what a follow-up ("put it back") refers to.
    if !anchors.is_empty() && state.answers.is_empty() {
        state.remember(anchors.clone(), false);
    }
    state.last_write = Some(LastWrite {
        command: cmd.verb.clone(),
        rows: anchors,
        revision_id: revision,
    });
    Plan::Wrote
}

/// Is the anchor SCOPED? R-R4 asks this of a destructive verb.
fn bounded(set: &Set) -> bool {
    match set {
        Set::Called { .. } | Set::Filter { .. } | Set::During { .. } | Set::First { .. } => true,
        Set::Ref(_) => true,
        Set::Order { set, .. } => bounded(set),
        Set::Union(left, right) | Set::Except(left, right) => bounded(left) && bounded(right),
        Set::Walk { from, .. } => bounded(from),
        Set::Kind(_) => false,
    }
}

/// The set that names the PERSON a party-subject verb is about — the walk's
/// source for `obligations of (parties …)`, the anchor itself otherwise.
fn subject_set(on: &Set) -> Option<&Set> {
    match on {
        Set::Walk { kind, from } if kind.kind == "obligations" => Some(from),
        Set::Called { set, .. } | Set::Filter { set, .. } | Set::During { set, .. } => {
            subject_set(set)
        }
        _ => None,
    }
}

/// The vault command and the JSON body one canonical `Cmd` becomes, for one
/// anchor row.
///
/// **The Args are the command's own schema** (§2.7): the canonical carries
/// what the member said and the executor fills in what the schema requires and
/// the canonical does not — the calendar id, the default split, the minted
/// locker id and the sealed cell (R-W3).
#[expect(
    clippy::too_many_lines,
    reason = "one arm per command, read as a table"
)]
fn body(
    cmd: &Cmd,
    anchor: Option<&VaultRow>,
    eval: &mut Eval<'_, '_>,
    state: &State,
) -> Result<(String, Json), Stop> {
    let verb = resolve_verb(&cmd.verb, anchor)?;
    let id = anchor.map(|row| row.id.clone()).unwrap_or_default();
    let arg = |name: &str| cmd.args.iter().find(|(key, _)| key == name).map(|(_, v)| v);
    let text = |name: &str| match arg(name) {
        Some(ArgVal::Lit(lit)) => Some(lit.value.clone()),
        _ => None,
    };
    let body = match verb.as_str() {
        "schedule.edit_task" => {
            let due = match arg("to") {
                Some(value) => stamp_arg(value, eval, "09:00")?,
                None => return Err(unhandled("a reschedule with no `to`")),
            };
            json!({ "task_id": id, "due_at": due })
        }
        "schedule.reschedule_event" => {
            let start = anchor.and_then(|row| row.date.clone()).unwrap_or_default();
            let end = anchor
                .and_then(|row| row.extra.get("dtend").cloned())
                .unwrap_or_else(|| start.clone());
            let (start, end) = match (arg("to"), arg("by")) {
                (Some(value), _) => {
                    let moved = stamp_arg(value, eval, &start[11..16.min(start.len())])?;
                    let shift = day_shift(&start, &moved);
                    (moved, shift_stamp(&end, &shift))
                }
                (None, Some(ArgVal::Lit(lit))) => {
                    (shift_by(&start, &lit.value), shift_by(&end, &lit.value))
                }
                _ => return Err(unhandled("a reschedule with neither `to` nor `by`")),
            };
            json!({ "event_id": id, "dtstart": start, "dtend": end })
        }
        "schedule.add_task" => {
            let title = text("title").ok_or_else(|| unhandled("a task with no title"))?;
            match arg("due_at") {
                Some(ArgVal::Lit(lit)) if lit.value == "null" => json!({ "title": title }),
                Some(value) => {
                    let due = stamp_arg(value, eval, "09:00")?;
                    json!({ "title": title, "due_at": due })
                }
                None => json!({ "title": title }),
            }
        }
        "schedule.set_task_status" => {
            let status = text("status").unwrap_or_else(|| "completed".to_owned());
            json!({ "task_id": id, "status": status })
        }
        "schedule.propose_event" => {
            let calendar = eval
                .board(App::Agenda)
                .into_iter()
                .find_map(|row| row.extra.get("calendar_id").cloned())
                .unwrap_or_default();
            let start = stamp_arg(
                arg("dtstart").ok_or_else(|| unhandled("an event with no start"))?,
                eval,
                "09:00",
            )?;
            let end = match arg("dtend") {
                Some(value) => stamp_arg(value, eval, "10:00")?,
                None => shift_by(&start, "+1h"),
            };
            let summary = text("summary").unwrap_or_default();
            json!({ "calendar_id": calendar, "summary": summary, "dtstart": start, "dtend": end })
        }
        "schedule.cancel_event" => json!({ "event_id": id }),
        "schedule.delete_task" => json!({ "task_id": id }),
        "schedule.restore_task" => json!({ "task_id": id }),
        "schedule.delete_event" => json!({ "event_id": id }),
        "knowledge.create_note" => {
            let title = text("title").ok_or_else(|| unhandled("a note with no title"))?;
            // The canonical carries no body; the command requires one, so the
            // title is repeated rather than a sentence being invented.
            json!({ "title": title.clone(), "body_text": title, "format": "plain" })
        }
        "knowledge.delete_note" => json!({ "note_id": id }),
        "core.trash_document" | "core.star_document" | "core.restore_document" => {
            json!({ "document_id": id })
        }
        "locker.add_item" => {
            let item_id = eval.ctx.mint();
            let key_id = eval.ctx.locker_key_id().map_err(unhandled)?;
            let kind = text("type").unwrap_or_else(|| "note".to_owned());
            let title = text("title").unwrap_or_default();
            let mut built = json!({
                "item_id": item_id, "type": kind, "title": title, "key_id": key_id,
            });
            // R-W3 — the SEAT seals, never the canonical: `locker.add_item`
            // refuses plaintext by name, so the id is minted first and the
            // cell is sealed against it.
            if let Some(content) = text("content") {
                let sealed = eval.ctx.seal(&item_id, &content).map_err(unhandled)?;
                built["content"] = json!(sealed);
            }
            built
        }
        "locker.trash_item" => json!({ "item_id": id }),
        "locker.reveal_receipt" => {
            let columns: Vec<String> = text("columns")
                .unwrap_or_else(|| "password".to_owned())
                .split(',')
                .map(|part| part.trim().to_owned())
                .collect();
            json!({
                "object_type": "locker.item", "item_id": id, "columns": columns,
                "kind": "reveal", "allowed": true,
            })
        }
        "media.add_to_album" => {
            let album = match arg("album_id") {
                Some(ArgVal::SetArg(set)) => {
                    let rows = eval.set(set)?;
                    if rows.len() != 1 {
                        return Err(Stop::Clarify);
                    }
                    rows[0].id.clone()
                }
                Some(ArgVal::Lit(lit)) => lit.value.clone(),
                _ => return Err(unhandled("no album named")),
            };
            json!({ "album_id": album, "asset_id": id })
        }
        "media.restore_asset" => json!({ "asset_id": id }),
        "media.delete_asset" => json!({ "asset_id": id }),
        "people.log_interaction" => {
            let kind = text("kind").unwrap_or_else(|| "call".to_owned());
            json!({ "party_id": id, "kind": kind })
        }
        "people.settle_debt" => json!({ "debt_id": id }),
        "people.trash_person" => json!({ "party_id": id }),
        "people.undo_person" => {
            let revision = state
                .last_write
                .as_ref()
                .and_then(|write| write.revision_id.clone())
                .ok_or(Stop::Clarify)?;
            json!({ "party_id": id, "revision_id": revision })
        }
        "tally.add_expense" => {
            let group = match arg("group_id") {
                Some(ArgVal::SetArg(set)) => {
                    let rows = eval.set(set)?;
                    if rows.len() != 1 {
                        return Err(Stop::Clarify);
                    }
                    Some(rows[0].id.clone())
                }
                Some(ArgVal::Lit(lit)) => Some(lit.value.clone()),
                _ => None,
            };
            let amount = text("amount_minor")
                .and_then(|raw| raw.parse::<i64>().ok())
                .ok_or_else(|| unhandled("an expense with no amount"))?;
            let me = eval.ctx.me().to_owned();
            let payer = match arg("paid_by") {
                Some(ArgVal::Lit(lit)) if lit.value == "me" => me.clone(),
                Some(ArgVal::Lit(lit)) => lit.value.clone(),
                Some(ArgVal::SetArg(set)) => {
                    let rows = eval.set(set)?;
                    if rows.len() != 1 {
                        return Err(Stop::Clarify);
                    }
                    rows[0].id.clone()
                }
                _ => me.clone(),
            };
            let mut built = json!({
                "description": text("description").unwrap_or_default(),
                "amount_minor": amount,
                "paid_by": payer,
                "category": text("category").unwrap_or_else(|| "general".to_owned()),
                "spent_on": eval.ctx.today(),
                "splits": [{ "party_id": me, "share_minor": amount }],
            });
            if let Some(group) = group {
                built["group_id"] = json!(group);
            }
            built
        }
        "tally.delete_expense" => json!({ "expense_id": id }),
        "tally.undo_expense" => {
            let revision = state
                .last_write
                .as_ref()
                .and_then(|write| write.revision_id.clone())
                .ok_or(Stop::Clarify)?;
            json!({ "expense_id": id, "revision_id": revision })
        }
        "tally.settle_up" => {
            let group = match arg("group_id") {
                Some(ArgVal::SetArg(set)) => {
                    let rows = eval.set(set)?;
                    if rows.len() != 1 {
                        return Err(Stop::Clarify);
                    }
                    rows[0].id.clone()
                }
                Some(ArgVal::Lit(lit)) => lit.value.clone(),
                _ => return Err(unhandled("a settlement with no group")),
            };
            let me = eval.ctx.me().to_owned();
            let members = eval
                .board(App::Tally)
                .into_iter()
                .find(|row| row.id == group)
                .map(|row| joined(row.extra.get("member_party_ids")))
                .unwrap_or_default();
            // R-W2 — inside `Args`, `it` is the anchor row being written, so
            // "settle up with everyone" pays each member their OWN balance.
            let from = match arg("from_party") {
                Some(ArgVal::SetArg(set)) => {
                    let mut rows = eval.set(set)?;
                    // A payment INTO a group is a payment by one of its
                    // members, so the roster narrows a name that matched
                    // several — the `group_id` the canonical already carries.
                    if rows.len() > 1 {
                        rows.retain(|row| members.contains(&row.id));
                    }
                    if rows.len() != 1 {
                        return Err(Stop::Clarify);
                    }
                    rows[0].id.clone()
                }
                Some(ArgVal::Lit(lit)) if lit.value == "me" => me.clone(),
                Some(ArgVal::Lit(lit)) => lit.value.clone(),
                Some(ArgVal::Value(_)) | None => id.clone(),
            };
            let amount = match arg("amount_minor") {
                Some(ArgVal::Lit(lit)) => lit.value.parse::<f64>().unwrap_or(0.0),
                Some(ArgVal::Value(value)) => bind_anchor(value, anchor, eval)?,
                _ => return Err(unhandled("a settlement with no amount")),
            };
            #[expect(clippy::cast_possible_truncation, reason = "minor units are integers")]
            let amount = amount.abs().round() as i64;
            json!({
                "from_party": from, "to_party": me, "amount_minor": amount,
                "group_id": group, "paid_on": eval.ctx.today(),
            })
        }
        "tally.add_group_member" => {
            let group = match arg("group_id") {
                Some(ArgVal::SetArg(set)) => {
                    let rows = eval.set(set)?;
                    if rows.len() != 1 {
                        return Err(Stop::Clarify);
                    }
                    rows[0].id.clone()
                }
                Some(ArgVal::Lit(lit)) => lit.value.clone(),
                _ => return Err(unhandled("no group named")),
            };
            json!({ "group_id": group, "party_id": id })
        }
        other => return Err(unhandled(format!("no body is known for `{other}`"))),
    };
    Ok((verb, body))
}

/// A verb CLASS resolves once the anchor's Kind is known (§2.7).
fn resolve_verb(verb: &str, anchor: Option<&VaultRow>) -> Result<String, Stop> {
    let classes = crate::canon::verb_classes();
    let Some(table) = classes.get(verb) else {
        return Ok(verb.to_owned());
    };
    let Some(anchor) = anchor else {
        return Err(Stop::Clarify);
    };
    table
        .get(anchor.entity.as_str())
        .map(|found| (*found).to_owned())
        .ok_or(Stop::Clarify)
}

/// A `Value` argument bound to THIS anchor row: `balance of (it) in (…)`.
fn bind_anchor(
    value: &Value,
    anchor: Option<&VaultRow>,
    eval: &mut Eval<'_, '_>,
) -> Result<f64, Stop> {
    match (value, anchor) {
        (
            Value::Balance {
                of: Set::Ref(Ref::It | Ref::Them | Ref::ThatOne),
                within,
            },
            Some(anchor),
        ) => {
            let group = eval.set(within)?;
            if group.len() != 1 {
                return Err(Stop::Clarify);
            }
            let group = group[0].id.clone();
            eval.balance(&anchor.id, &group)
        }
        _ => eval.number(value),
    }
}

/// A date or datetime argument, as the command plane spells a stamp.
fn stamp_arg(value: &ArgVal, eval: &mut Eval<'_, '_>, default_time: &str) -> Result<String, Stop> {
    let raw = match value {
        ArgVal::Lit(lit) => lit.value.clone(),
        ArgVal::Value(value) => eval.one_value(value)?,
        ArgVal::SetArg(_) => return Err(unhandled("a set where a stamp was wanted")),
    };
    Ok(normalise_stamp(&raw, default_time))
}

fn normalise_stamp(raw: &str, default_time: &str) -> String {
    let time = if raw.len() >= 16 {
        raw[11..16].to_owned()
    } else if default_time.len() == 5 {
        default_time.to_owned()
    } else {
        "09:00".to_owned()
    };
    format!("{}T{time}:00.000Z", &raw[..10.min(raw.len())])
}

/// How many days apart two stamps are, as a signed day count.
fn day_shift(from: &str, to: &str) -> i64 {
    if from.len() < 10 || to.len() < 10 {
        return 0;
    }
    let mut days = 0i64;
    let mut walk = from[..10].to_owned();
    let target = to[..10].to_owned();
    let forward = walk < target;
    while walk != target && days.abs() < 400 {
        days += if forward { 1 } else { -1 };
        walk = calendar::shift(&from[..10], days);
    }
    days
}

fn shift_stamp(stamp: &str, days: &i64) -> String {
    if stamp.len() < 10 {
        return stamp.to_owned();
    }
    format!("{}{}", calendar::shift(&stamp[..10], *days), &stamp[10..])
}

/// `by: +1h` — the same wall-clock day, an hour later.
fn shift_by(stamp: &str, duration: &str) -> String {
    if stamp.len() < 16 {
        return stamp.to_owned();
    }
    let sign = if duration.starts_with('-') { -1 } else { 1 };
    let amount: i64 = duration[1..duration.len() - 1].parse().unwrap_or(0);
    let unit = duration.chars().last().unwrap_or('h');
    match unit {
        'd' => shift_stamp(stamp, &(sign * amount)),
        'm' => {
            let minutes: i64 = stamp[14..16].parse().unwrap_or(0) + sign * amount;
            format!(
                "{}{:02}{}",
                &stamp[..14],
                minutes.rem_euclid(60),
                &stamp[16..]
            )
        }
        _ => {
            let hours: i64 = stamp[11..13].parse().unwrap_or(0) + sign * amount;
            format!("{}{:02}{}", &stamp[..11], hours, &stamp[13..])
        }
    }
}
