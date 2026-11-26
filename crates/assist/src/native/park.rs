//! PARK: a write that is planned, and shown to the model, but not made until the member taps
//! (#1088, R-1088-2, R-1088-6, R-1088-10).
//!
//! On the phone every write waits for the member's tap. The runtime still plans it as it always
//! has and shows the model what it was trained to see after a write: the change lines of the
//! row, the `created:` echo, the diff. It does that against a PATCHED COPY OF THE WORLD instead
//! of the vault: `apply` takes the command a step would have run and does to the in-memory
//! [`World`] what the vault's command does to its tables, as far as the model's rows can tell.
//! Every later call of the turn then reads the patched world, so a `more=true` chain that names a
//! row the first write created works, and the observation text is the one a run would have shown.
//!
//! # The pending write
//!
//! The steps themselves are kept, in order, as [`ParkedStep`]s. The step that ends the turn carries
//! them as `effect.pending` ([`PendingWrite`]): one per session, in memory, dismissed by a new
//! message and inert in a reopened thread. [`Session::confirm`] checks that the rows the steps
//! address still read as they did, runs the steps through [`crate::native::door::Door::act_keyed`] call by call and
//! reads the vault after each, so the after-write text is the vault's own; [`Session::dismiss`]
//! puts the session back as the turn found it. `Door` documents what the core owes both.
//!
//! # What a patch owes the vault
//!
//! * The refusals the runtime acts on (`Session::refusal`): the id of
//!   the check that fails and its sentence are the vault's own, and a refusal changes nothing.
//! * The shape of every row a command touches, field for field, as `World::load` would read it
//!   back. `tests/park.rs` holds every `(verb, kind)` of the table to a real vault in
//!   [`Writes::Shadow`], and holds the texts to a run's.
//! * Ids: a row the runtime names before its command (`Door::mint_id`) keeps that id, a person
//!   included (the vault honours a seat-minted party id); an id the vault makes inside a command
//!   (an album's revision) is minted here for the card and replaced by the real one when
//!   its step runs, in the later steps and in the undo memory.
//!
//! # What a patch cannot know
//!
//! What only the vault's tables hold and the world does not read: the next occurrence a repeating
//! task makes when it is completed (the card shows the completion; the vault's own after-write text
//! shows the successor), and the stamp a trigger puts on `updated` from the host clock (so
//! `updated` is not compared). A command this file does not name is an error, never a guess.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::native::door::{Call, Inverse, Ran};
use crate::native::meta::{Kind, Verb, Via};
use crate::native::world::{Edge, Key, Row, Val, World};

/// What a session does with a write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Writes {
    /// The vault runs every step (the harness, and every run the model was trained on).
    #[default]
    Run,
    /// No step reaches the vault: it is applied to a patched copy of the world and parked.
    Park,
    /// The vault runs every step AND the patched world follows it; after each write the two are
    /// compared and a difference is kept (`Session::take_drift`). The check that holds `apply` to
    /// the vault; the harness binary takes it as `--writes shadow`.
    Shadow,
}

impl Writes {
    /// The flag spelling (`--writes run|park|shadow`).
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "run" => Some(Self::Run),
            "park" => Some(Self::Park),
            "shadow" => Some(Self::Shadow),
            _ => None,
        }
    }
}

/// One step the turn would have run, and what the patch said it produced.
#[derive(Debug, Clone, PartialEq)]
pub struct ParkedStep {
    /// The write call of the turn that made the step (an index into its calls, in order).
    pub call: usize,
    /// What the step runs: the manifest action, with its command.
    pub act: Call,
    pub input: Value,
    /// The patched world's answer: an id the vault mints inside a command (a `revision_id`, the
    /// successor of a repeating task) is a placeholder the real run replaces. A created row's id is
    /// not one: the call names it before the command runs (`Writes::Park` pre-mints it) and the
    /// vault honours it.
    pub output: Value,
}

/// The state a parking session keeps.
#[derive(Debug, Default)]
pub(crate) struct ParkState {
    /// The vault as the parked steps would leave it. `None` in [`Writes::Run`].
    pub world: Option<World>,
    /// Every step applied since the last settle, in order.
    pub steps: Vec<ParkedStep>,
    /// [`Writes::Shadow`]: where the patched world and the vault part.
    pub drift: Vec<String>,
    /// Albums deleted by a parked step, by the revision id the delete answered: what
    /// `media.restore_album` puts back.
    pub bin: BTreeMap<String, (Row, Vec<Edge>)>,
    /// The world the turn planned its writes against: the vault's, as read when the turn began.
    pub before: Option<World>,
    /// The call the running step parked, until `park_capture` has its final text.
    pub call: Option<ParkedCall>,
    /// Every call of the turn that parked something.
    pub calls: Vec<ParkedCall>,
    /// What the session remembered before the turn: what a dismissal puts back.
    pub memory: Option<Memory>,
    /// The one pending write of the session (R-1088-10).
    pub pending: Option<PendingWrite>,
    /// The last confirm, kept so one sent twice answers the same and writes once.
    pub confirmed: Option<(String, Confirmed)>,
}

/// One call that parked a write: the verb, the lines it showed for the rows it changed and the
/// text it ended in. A confirm regenerates the lines from the vault's own before and after.
#[derive(Debug, Clone)]
pub(crate) struct ParkedCall {
    pub verb: Verb,
    /// `(row, its #n, the change line shown)`.
    pub lines: Vec<(Key, usize, String)>,
    /// The same rows as facts, for the card (`native_turn` says them in words).
    pub changes: Vec<RowChange>,
    /// Rows the call changes beyond the ones listed.
    pub more: usize,
    pub text: String,
}

/// A field a parked write moves, spelled for display: `due`, `"Call plumber"`, `tomorrow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldChange {
    pub field: String,
    /// `None` when the row had no value before (or does not exist yet).
    pub from: Option<String>,
    /// `None` when the value goes away.
    pub to: Option<String>,
}

/// A link a parked write makes or breaks: the row is now in, or no longer in, this container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkChange {
    pub added: bool,
    pub kind: &'static str,
    pub title: String,
}

/// ONE ROW A PARKED CALL CHANGES, as facts: the kind and title of the row, what moves on it and
/// the links it gains or loses. The card says it in words (`native_turn`); the model's change
/// line is the same change spelled for the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowChange {
    /// The verb's name: `complete`, `delete`, `add_to`…
    pub verb: &'static str,
    pub kind: &'static str,
    pub title: String,
    /// The row did not exist before the call; `fields` are its starting values.
    pub created: bool,
    pub fields: Vec<FieldChange>,
    pub links: Vec<LinkChange>,
    /// The name the kind's one date goes by in `fields` (`due`, `starts`...): the card reads
    /// its "when" from that field.
    pub date_label: &'static str,
}

/// Whether a verb deletes, removes or cancels: the writes a card asks twice for.
#[must_use]
pub fn destructive_verb(verb: &str) -> bool {
    matches!(verb, "delete" | "remove_from" | "cancel")
}

/// What the session remembers of a conversation that a write changes, as it was when the turn
/// began: a dismissed turn leaves none of it behind.
#[derive(Debug, Clone)]
pub(crate) struct Memory {
    writes: usize,
    undone: std::collections::BTreeSet<usize>,
    noops: std::collections::BTreeSet<usize>,
    acted: std::collections::BTreeSet<usize>,
    created: Vec<usize>,
    marks: Vec<crate::native::session::Mark>,
}

/// THE PENDING WRITE: every write of one turn, planned against a patched world and waiting for the
/// member's tap (R-1088-2, R-1088-6). One per session, in memory (R-1088-10): a new message
/// dismisses it, and a reopened thread starts a fresh session that never had it.
#[derive(Debug, Clone)]
pub struct PendingWrite {
    pub id: String,
    pub turn: usize,
    /// The verbs of the turn's write calls, in order.
    pub verbs: Vec<&'static str>,
    /// The commands a confirm runs, in order.
    pub steps: Vec<ParkedStep>,
    /// What the card says will change: the change lines the calls showed the model.
    pub preview: Vec<String>,
    /// The same rows as facts, in order: what the member's card is made of.
    pub changes: Vec<RowChange>,
    /// Rows the calls change beyond the ones listed (a bulk write lists its first twelve).
    pub more: usize,
    /// What `undo` would run to take it back, and what it cannot take back.
    pub inverses: Vec<(String, Value)>,
    pub not_undoable: Vec<String>,
    /// How each row the steps address read when they were planned: a confirm that finds any of them
    /// read differently is stale.
    base: BTreeMap<Key, String>,
    before: World,
    calls: Vec<ParkedCall>,
}

impl PendingWrite {
    /// Whether the card should ask twice: a delete or a removal, a cancel, a money write, or
    /// anything the vault cannot take back.
    #[must_use]
    pub fn destructive(&self) -> bool {
        !self.not_undoable.is_empty() || self.verbs.iter().any(|verb| destructive_verb(verb))
    }

    /// The secrets the member typed into this write's steps (#1135), which the runtime holds only
    /// here: the log, the stored question and the card carry the placeholder.
    #[must_use]
    pub fn typed_secrets(&self) -> Vec<String> {
        self.steps
            .iter()
            .flat_map(|step| crate::native::member::typed_secrets(&step.input))
            .collect()
    }

    /// The pending write as the core hands it to the shell.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "turn": self.turn,
            "verbs": self.verbs,
            "preview": self.preview,
            "steps": self.steps.iter().map(|step| json!({"command": step.act.command, "input": crate::native::member::masked(&step.input)})).collect::<Vec<_>>(),
            "destructive": self.destructive(),
            "not_undoable": self.not_undoable,
        })
    }
}

/// What a confirm did.
#[derive(Debug, Clone, PartialEq)]
pub enum Confirmed {
    /// Every step ran. `text` is the vault's own after-write observation of the turn (the parked
    /// text, with the change lines read back from the vault) and `diff` its effect.
    Done {
        text: String,
        diff: Value,
        steps: usize,
        /// What takes each write back, one entry per write in the order they ran; a write with no
        /// inverse is an empty entry. The card draws one line per entry.
        undo: Vec<Inverse>,
    },
    /// A row the steps address reads differently than when they were planned: nothing ran.
    Stale { rows: Vec<String> },
    /// The vault refused a step. Steps before it ran (a batch is not atomic across commands).
    Refused {
        step: usize,
        command: String,
        predicate: String,
        reason: String,
        landed: usize,
    },
    /// A step seals a secret the member typed and the Locker is shut: nothing ran, and the card
    /// is still waiting. The member unlocks and taps again.
    Locked,
    /// No pending write by that id: dismissed, replaced, or never made.
    Unknown,
}

impl Confirmed {
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Done {
                text, diff, steps, ..
            } => {
                json!({"status": "done", "text": text, "diff": diff, "steps": steps})
            }
            Self::Stale { rows } => json!({"status": "stale", "rows": rows}),
            Self::Refused {
                step,
                command,
                predicate,
                reason,
                landed,
            } => json!({
                "status": "refused", "step": step, "command": command,
                "predicate": predicate, "reason": reason, "landed": landed,
            }),
            Self::Locked => json!({"status": "locked"}),
            Self::Unknown => json!({"status": "unknown"}),
        }
    }
}

/// What a patch needs of the session.
pub(crate) struct Cx {
    pub now: String,
}

fn ok(output: Value) -> Ran {
    Ran {
        ok: true,
        output,
        reason: None,
        predicate: None,
        inverse: None,
    }
}

fn refused(predicate: &str, reason: &str) -> Ran {
    Ran {
        ok: false,
        output: Value::Null,
        reason: Some(reason.to_owned()),
        predicate: Some(predicate.to_owned()),
        inverse: None,
    }
}

fn text<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    input.get(key).and_then(Value::as_str)
}

impl Cx {}

/// How long a trashed row stays restorable.
const PURGE_MS: i64 = 30 * 86_400_000;

/// The instant a row trashed now is purged, in the shape the column holds.
fn purge_at(now: &str) -> String {
    let millis = centraid_vault::clock::parse_iso_ms(now).unwrap_or_default();
    centraid_vault::clock::format_iso_ms(millis + PURGE_MS)
}

fn edge(world: &mut World, from: Key, to: Key, via: Via) {
    if world.rows.contains_key(&from) && world.rows.contains_key(&to) {
        world.edges.push(Edge { from, to, via });
        world.edges.sort();
        world.edges.dedup();
    }
}

fn unlink(world: &mut World, keep: impl Fn(&Edge) -> bool) {
    world.edges.retain(keep);
}

/// A trashed row: dated shut now, restorable for the window.
fn trash(row: &mut Row, cx: &Cx) {
    row.trashed = true;
    row.updated = cx.now.clone();
    row.extra.insert("purge_at", purge_at(&cx.now));
}

fn untrash(row: &mut Row, cx: &Cx) {
    row.trashed = false;
    row.updated = cx.now.clone();
    row.extra.remove("purge_at");
}

/// Apply one command to the patched world: what the vault's command does, as far as the model's
/// rows can tell. A refusal is a value and changes nothing; an `Err` is a command this file does
/// not know.
pub(crate) fn apply(
    world: &mut World,
    bin: &mut BTreeMap<String, (Row, Vec<Edge>)>,
    cx: &Cx,
    command: &str,
    input: &Value,
) -> Result<Ran, String> {
    match command {
        "entity.retitle" => retitle(world, cx, input),
        "entity.trash" => trash_entity(world, bin, cx, input),
        "entity.restore" => restore_entity(world, bin, cx, input),
        "entity.purge" => purge_entity(world, input),
        "flag.set" | "flag.clear" => flag_entity(world, input, command == "flag.set"),
        "tag.add" | "tag.remove" => tag_entity(world, input),
        "edge.add" | "edge.remove" => edge_entity(world, input, command == "edge.add"),
        other => Err(format!(
            "error: park has no patch for {other}; the write cannot be shown before it is made."
        )),
    }
}

// ---------------------------------------------------------------------
// the shared shapes
// ---------------------------------------------------------------------

/// The key of the row with this id, whatever its kind.
fn key_of(world: &World, id: &str) -> Option<Key> {
    world.rows.keys().find(|(_, row)| row == id).cloned()
}

/// The sentence the vault says for an id that cannot be acted on: not there, or in the trash.
fn gone(world: &World, id: &str) -> String {
    match key_of(world, id).and_then(|key| world.rows.get(&key)) {
        Some(row) if row.trashed => format!("“{}” is in the trash; restore it first", row.name),
        _ => format!("there is nothing with the id `{id}`"),
    }
}

/// The containers the model takes out of the world when they go to the trash.
fn is_container(_kind: Kind) -> bool {
    false
}

/// The kinds that leave the model's world when they go to the trash.
fn leaves_when_trashed(kind: Kind) -> bool {
    is_container(kind)
}

/// What goes to the trash with a holder, and comes back with it (the vault's `members`).
fn members(_world: &World, _holder: &Key) -> Vec<Key> {
    Vec::new()
}

fn trash_with(
    world: &mut World,
    bin: &mut BTreeMap<String, (Row, Vec<Edge>)>,
    cx: &Cx,
    key: &Key,
    out: &mut Vec<String>,
) {
    let kids = members(world, key);
    if leaves_when_trashed(key.0) {
        // a row the model has no trash for leaves the world, with the edges it held
        let held: Vec<Edge> = world
            .edges
            .iter()
            .filter(|edge| edge.from == *key || edge.to == *key)
            .cloned()
            .collect();
        unlink(world, |edge| !(edge.from == *key || edge.to == *key));
        if let Some(mut row) = world.rows.remove(key) {
            row.extra.insert("purge_at", purge_at(&cx.now));
            bin.insert(key.1.clone(), (row, held));
        }
    } else if let Some(row) = world.rows.get_mut(key) {
        trash(row, cx);
    }
    out.push(key.1.clone());
    for kid in kids {
        if world.rows.get(&kid).is_some_and(|row| !row.trashed) {
            trash_with(world, bin, cx, &kid, out);
        }
    }
}

fn trash_entity(
    world: &mut World,
    bin: &mut BTreeMap<String, (Row, Vec<Edge>)>,
    cx: &Cx,
    input: &Value,
) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(key) = key_of(world, id).filter(|key| world.rows[key].trashed.eq(&false)) else {
        return Ok(refused("entity_can_be_trashed", &gone(world, id)));
    };
    let mut trashed = Vec::new();
    trash_with(world, bin, cx, &key, &mut trashed);
    Ok(ok(
        json!({"trashed": trashed, "purge_at": purge_at(&cx.now)}),
    ))
}

fn restore_with(
    world: &mut World,
    bin: &mut BTreeMap<String, (Row, Vec<Edge>)>,
    cx: &Cx,
    key: &Key,
    stamp: &str,
    out: &mut Vec<String>,
) {
    if let Some((mut row, held)) = bin.remove(&key.1) {
        row.extra.remove("purge_at");
        row.updated = cx.now.clone();
        world.rows.insert(row.key(), row);
        for edge in held {
            world.edges.push(edge);
        }
        world.edges.sort();
        world.edges.dedup();
    } else if let Some(row) = world.rows.get_mut(key) {
        untrash(row, cx);
    }
    out.push(key.1.clone());
    // what went to the trash WITH the holder comes back with it; what was already there stays
    for kid in members(world, key) {
        let with_it = world.rows.get(&kid).is_some_and(|row| {
            row.trashed && row.extra.get("purge_at").map(String::as_str) == Some(stamp)
        });
        if with_it {
            restore_with(world, bin, cx, &kid, stamp, out);
        }
    }
}

fn restore_entity(
    world: &mut World,
    bin: &mut BTreeMap<String, (Row, Vec<Edge>)>,
    cx: &Cx,
    input: &Value,
) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let (key, row) = match bin.get(id) {
        Some((row, _)) => (row.key(), row.clone()),
        None => match key_of(world, id)
            .and_then(|key| world.rows.get(&key).map(|row| (key, row.clone())))
        {
            Some(found) => found,
            None => {
                return Ok(refused(
                    "entity_is_in_the_trash",
                    &format!("there is nothing with the id `{id}`"),
                ));
            }
        },
    };
    let trashed = row.trashed || bin.contains_key(id);
    if !trashed {
        return Ok(refused(
            "entity_is_in_the_trash",
            &format!("“{}” is not in the trash", row.name),
        ));
    }
    let stamp = row.extra.get("purge_at").cloned().unwrap_or_default();
    let mut restored = Vec::new();
    restore_with(world, bin, cx, &key, &stamp, &mut restored);
    Ok(ok(json!({"restored": restored})))
}

/// A purge, as far as the model reads one: a row that is in the trash goes.
fn purge_entity(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    match key_of(world, &id) {
        Some(key) if world.rows[&key].trashed => {
            world.rows.remove(&key);
            unlink(world, |edge| !(edge.from == key || edge.to == key));
            Ok(ok(json!({"purged": [id]})))
        }
        Some(key) => Ok(refused(
            "entity_can_be_purged",
            &format!(
                "“{}” is not in the trash; move it there first",
                world.rows[&key].name
            ),
        )),
        None => Ok(refused(
            "entity_can_be_purged",
            &format!("there is nothing with the id `{id}`"),
        )),
    }
}

fn retitle(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let title = text(input, "title").unwrap_or_default().trim().to_owned();
    let Some(key) = key_of(world, id).filter(|key| !world.rows[key].trashed) else {
        return Ok(refused("title_is_changeable", &gone(world, id)));
    };
    if title.is_empty() {
        return Ok(refused(
            "title_is_changeable",
            &format!("a {} needs a name", key.0.name()),
        ));
    }
    if let Some(row) = world.rows.get_mut(&key) {
        row.name = if title.is_empty() {
            "untitled".to_owned()
        } else {
            title
        };
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"id": id})))
}

fn flag_entity(world: &mut World, input: &Value, on: bool) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let flag = text(input, "flag").unwrap_or("starred");
    let Some(key) = key_of(world, id).filter(|key| !world.rows[key].trashed) else {
        return Ok(refused("entity_takes_a_flag", &gone(world, id)));
    };
    if let Some(row) = world.rows.get_mut(&key)
        && matches!(flag, "starred" | "pinned")
    {
        row.fields.insert(
            if flag == "starred" {
                "starred"
            } else {
                "pinned"
            },
            Val::Bool(on),
        );
    }
    Ok(ok(json!({"changed": true})))
}

/// A tag: a word the member puts on a row. The world does not read tags, so the patch is the
/// vault's refusals and nothing else: the row is there and live, and the label is a word.
fn tag_entity(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    if key_of(world, id).is_none_or(|key| world.rows[&key].trashed) {
        return Ok(refused("entity_takes_a_tag", &gone(world, id)));
    }
    if text(input, "label").is_none_or(|label| label.trim().is_empty()) {
        return Ok(refused(
            "label_is_a_word",
            "a label needs at least one character",
        ));
    }
    Ok(ok(json!({"changed": true})))
}

/// An edge the model reads: a photograph in an album (`contains`) or of a person (`depicts`), a line with a person (`with`), what a note, task, event or document is
/// `about`, and who attends an event.
fn edge_entity(world: &mut World, input: &Value, add: bool) -> Result<Ran, String> {
    let (from, to) = (
        text(input, "from").unwrap_or_default(),
        text(input, "to").unwrap_or_default(),
    );
    let via = match text(input, "rel") {
        Some("contains") => Via::Entry,
        Some("about") => Via::About,
        Some("with") => Via::With,
        Some("depicts") => Via::Depicts,
        Some("attendee") => Via::Attendee,
        other => return Err(format!("error: park has no patch for an edge of {other:?}")),
    };
    let (Some(from), Some(to)) = (key_of(world, from), key_of(world, to)) else {
        let predicate = if add {
            "edge_joins_what_it_may"
        } else {
            "edge_ends_exist"
        };
        return Ok(refused(predicate, "there is nothing with that id"));
    };
    let held = world
        .edges
        .iter()
        .any(|edge| edge.via == via && edge.from == from && edge.to == to);
    if add {
        edge(world, from, to, via);
    } else {
        if !held {
            return Ok(refused("edge_ends_exist", "that edge is not there"));
        }
        unlink(world, |edge| {
            !(edge.via == via && edge.from == from && edge.to == to)
        });
    }
    Ok(ok(json!({})))
}

// ---------------------------------------------------------------------
// people
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// events
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// documents and containers
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// the session's side
// ---------------------------------------------------------------------

use crate::native::session::Session;

impl Session {
    /// Remember the sealed fields a Locker write sets (#1135): the world reads a sealed cell as a
    /// presence bit, so a secret the member typed is a change the diff and the change line can only
    /// learn here.
    pub(crate) fn note_sealed_moves(&mut self, command: &str, input: &Value) {
        if !matches!(command, "locker.add_item" | "locker.edit_item") {
            return;
        }
        let Some(item) = input["item_id"].as_str() else {
            return;
        };
        for (name, column) in crate::native::meta::REVEAL_FIELDS {
            if !crate::native::member::typed_secrets(
                &serde_json::json!({ *column: input[*column].clone() }),
            )
            .is_empty()
            {
                let name = if *column == "content" { "notes" } else { *name };
                self.sealed_moves
                    .entry(item.to_owned())
                    .or_default()
                    .insert(name);
            }
        }
    }

    /// Run one write step: the vault runs it ([`Writes::Run`]), or the patched world takes it
    /// and the step is parked ([`Writes::Park`]), or both ([`Writes::Shadow`]). The clock moves
    /// on first in every mode, so a session's writes land in the order they were made.
    pub(crate) fn write_step(&mut self, call: &Call, input: &Value) -> Result<Ran, String> {
        let command = call.command;
        self.note_sealed_moves(command, input);
        match self.flags.writes {
            Writes::Run => self.door.step(call, input.clone()),
            Writes::Park => {
                self.park_first();
                self.door.advance();
                let ran = self.patch(command, input, None)?;
                if ran.ok {
                    self.park.steps.push(ParkedStep {
                        call: self.park.calls.len(),
                        act: *call,
                        input: input.clone(),
                        output: ran.output.clone(),
                    });
                }
                Ok(ran)
            }
            Writes::Shadow => {
                let real = self.door.step(call, input.clone())?;
                if real.ok {
                    match self.patch(command, input, Some(&real.output)) {
                        Ok(ran) if ran.ok => {}
                        Ok(ran) => self.park.drift.push(format!(
                            "{command}: the vault ran it, the patch refused it ({}: {})",
                            ran.predicate.unwrap_or_default(),
                            ran.reason.unwrap_or_default()
                        )),
                        Err(error) => self.park.drift.push(format!("{command}: {error}")),
                    }
                } else if let Ok(ran) = self.patch(command, input, None) {
                    if ran.ok {
                        self.park.drift.push(format!(
                            "{command}: the vault refused it ({}), the patch ran it",
                            real.predicate.clone().unwrap_or_default()
                        ));
                    } else if ran.predicate != real.predicate || ran.reason != real.reason {
                        self.park.drift.push(format!(
                            "{command}: refused as {:?} / {:?}, the patch said {:?} / {:?}",
                            real.predicate, real.reason, ran.predicate, ran.reason
                        ));
                    }
                }
                Ok(real)
            }
        }
    }

    fn patch(
        &mut self,
        command: &str,
        input: &Value,
        _real: Option<&Value>,
    ) -> Result<Ran, String> {
        let now = centraid_vault::clock::format_iso_ms(self.door.now_ms());
        let cx = Cx { now };
        let world = self
            .park
            .world
            .as_mut()
            .ok_or("error: a parking session has no patched world")?;
        apply(world, &mut self.park.bin, &cx, command, input)
    }

    /// The world after a write: the vault's, re-read ([`Writes::Run`]); the patched one
    /// ([`Writes::Park`]); or the vault's, held to the patched one first ([`Writes::Shadow`]).
    pub(crate) fn settle(&mut self) -> Result<(), String> {
        match self.flags.writes {
            Writes::Run => {
                self.world = self.load_world()?;
            }
            Writes::Park => {
                self.world = self
                    .park
                    .world
                    .clone()
                    .ok_or("error: a parking session has no patched world")?;
            }
            Writes::Shadow => {
                let real = self.load_world()?;
                if let Some(patched) = &self.park.world {
                    let apart = drift(patched, &real);
                    self.park.drift.extend(apart);
                }
                // the next write is held to the vault's world, not to a patched one that already
                // parted from it
                self.park.world = Some(real.clone());
                self.world = real;
            }
        }
        Ok(())
    }

    /// Where the patched world and the vault parted ([`Writes::Shadow`]), and clear the list.
    pub fn take_drift(&mut self) -> Vec<String> {
        std::mem::take(&mut self.park.drift)
    }

    /// The steps parked since the last settle ([`Writes::Park`]).
    #[must_use]
    pub fn parked(&self) -> &[ParkedStep] {
        &self.park.steps
    }
}

/// Where two worlds part, field by field: what a patch got wrong. `updated` is left out (a
/// trigger stamps it from the host clock).
pub(crate) fn drift(patched: &World, real: &World) -> Vec<String> {
    let mut out = Vec::new();
    let keys: std::collections::BTreeSet<&Key> =
        patched.rows.keys().chain(real.rows.keys()).collect();
    for key in keys {
        let name = |row: &Row| format!("{} {} ({})", key.0.name(), row.name, key.1);
        match (patched.rows.get(key), real.rows.get(key)) {
            (Some(row), None) => out.push(format!("{}: only the patch has it", name(row))),
            (None, Some(row)) => out.push(format!("{}: only the vault has it", name(row))),
            (Some(a), Some(b)) => {
                let mut parts = Vec::new();
                if a.name != b.name {
                    parts.push(format!("name {:?} / {:?}", a.name, b.name));
                }
                if a.date != b.date {
                    parts.push(format!("date {:?} / {:?}", a.date, b.date));
                }
                if a.fields != b.fields {
                    parts.push(format!("fields {:?} / {:?}", a.fields, b.fields));
                }
                if a.trashed != b.trashed {
                    parts.push(format!("trashed {} / {}", a.trashed, b.trashed));
                }
                if a.created != b.created {
                    parts.push(format!("created {} / {}", a.created, b.created));
                }
                if a.extra != b.extra {
                    parts.push(format!("extra {:?} / {:?}", a.extra, b.extra));
                }
                if !parts.is_empty() {
                    out.push(format!("{}: {}", name(a), parts.join("; ")));
                }
            }
            (None, None) => {}
        }
    }
    let edges = |world: &World| -> std::collections::BTreeSet<(Key, Key, Via)> {
        world
            .edges
            .iter()
            .map(|edge| (edge.from.clone(), edge.to.clone(), edge.via))
            .collect()
    };
    let (a, b) = (edges(patched), edges(real));
    for edge in a.difference(&b) {
        out.push(format!("edge {:?} only in the patch", edge));
    }
    for edge in b.difference(&a) {
        out.push(format!("edge {:?} only in the vault", edge));
    }
    if patched.areas != real.areas {
        out.push(format!("areas {:?} / {:?}", patched.areas, real.areas));
    }
    out
}

// ---------------------------------------------------------------------
// the Locker (a parked turn sees the plain half; the sealed cells are placeholders, `Flags::secrets`)
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// park, confirm, dismiss
// ---------------------------------------------------------------------

fn substitute(value: &mut Value, aliases: &BTreeMap<String, String>) {
    match value {
        Value::String(text) => {
            if let Some(real) = aliases.get(text.as_str()) {
                text.clone_from(real);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| substitute(item, aliases)),
        Value::Object(map) => map.values_mut().for_each(|item| substitute(item, aliases)),
        _ => {}
    }
}

fn strings<'v>(value: &'v Value, out: &mut Vec<&'v str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings(item, out)),
        _ => {}
    }
}

/// How a row reads: the fields the model sees, its trash state and its edges. What a stale check
/// compares, since a timestamp is not stamped by every write.
fn fingerprint(world: &World, key: &Key) -> String {
    let Some(row) = world.rows.get(key) else {
        return "absent".to_owned();
    };
    let mut edges: Vec<String> = world
        .edges
        .iter()
        .filter(|edge| edge.from == *key || edge.to == *key)
        .map(|edge| format!("{:?}>{:?}:{:?}", edge.from, edge.to, edge.via))
        .collect();
    edges.sort();
    format!(
        "{:?}|{}",
        crate::native::act::snapshot(row),
        edges.join(",")
    )
}

impl Session {
    /// The pending write, while the member has not answered it.
    #[must_use]
    pub fn pending(&self) -> Option<&PendingWrite> {
        self.park.pending.as_ref()
    }

    /// A write call parked: its verb and the lines it showed (`Session::execute`, `Session::undo`).
    pub(crate) fn park_call(
        &mut self,
        verb: Verb,
        lines: Vec<(Key, usize, String)>,
        changes: Vec<RowChange>,
        more: usize,
    ) {
        if self.flags.writes == Writes::Park {
            self.park.call = Some(ParkedCall {
                verb,
                lines,
                changes,
                more,
                text: String::new(),
            });
        }
    }

    /// The step is final: keep the text of the call that parked, and, when the turn ends, make the
    /// turn's pending write.
    pub(crate) fn park_capture(&mut self, outcome: &mut crate::native::session::Outcome) {
        if self.flags.writes != Writes::Park {
            return;
        }
        if let Some(mut call) = self.park.call.take() {
            call.text.clone_from(&outcome.text);
            self.park.calls.push(call);
        }
        if outcome.ends_turn && !self.park.steps.is_empty() {
            let pending = self.make_pending();
            outcome
                .effect
                .insert("pending".to_owned(), pending.to_json());
            self.park.pending = Some(pending);
        }
    }

    fn make_pending(&mut self) -> PendingWrite {
        let before = self
            .park
            .before
            .clone()
            .unwrap_or_else(|| self.world.clone());
        let steps = self.park.steps.clone();
        let calls = self.park.calls.clone();
        let (inverses, not_undoable) =
            self.writes
                .iter()
                .filter(|(turn, ..)| *turn == self.turn)
                .fold(
                    (Vec::new(), Vec::new()),
                    |(mut inverses, mut notes), (_, list, more)| {
                        inverses.extend(list.iter().map(|inverse| {
                            (inverse.act.command.to_owned(), inverse.input.clone())
                        }));
                        notes.extend(more.iter().cloned());
                        (inverses, notes)
                    },
                );
        let mut ids = Vec::new();
        for step in &steps {
            strings(&step.input, &mut ids);
        }
        let base = before
            .rows
            .keys()
            .filter(|key| ids.contains(&key.1.as_str()))
            .map(|key| (key.clone(), fingerprint(&before, key)))
            .collect();
        PendingWrite {
            id: self.door.mint_id(),
            turn: self.turn,
            verbs: calls.iter().map(|call| call.verb.spec().name).collect(),
            preview: calls
                .iter()
                .flat_map(|call| call.lines.iter().map(|(_, _, line)| line.clone()))
                .collect(),
            changes: calls
                .iter()
                .flat_map(|call| call.changes.iter().cloned())
                .collect(),
            more: calls.iter().map(|call| call.more).sum(),
            steps,
            inverses,
            not_undoable,
            base,
            before,
            calls,
        }
    }

    /// The first parked step of a turn: the world it plans against, kept to read the after-state
    /// back against.
    pub(crate) fn park_first(&mut self) {
        if self.park.before.is_none() {
            self.park.before = Some(self.world.clone());
        }
    }

    /// A turn begins: the pending write of the last one, if the member did not answer it, is
    /// dismissed (one per session), and the world is read afresh so the turn plans against what
    /// the vault holds now.
    pub(crate) fn park_begin_turn(&mut self) {
        if self.flags.writes != Writes::Park {
            return;
        }
        self.discard();
        self.park.memory = Some(Memory {
            writes: self.writes.len(),
            undone: self.undone.clone(),
            noops: self.noops.clone(),
            acted: self.acted.clone(),
            created: self.created.clone(),
            marks: self.marks.clone(),
        });
    }

    /// Put the session back as the turn found it and read the vault again: nothing the parked
    /// steps did is left, in the world or in what the conversation remembers.
    pub(crate) fn discard(&mut self) {
        if let Some(memory) = self.park.memory.take()
            && (self.park.pending.is_some() || !self.park.steps.is_empty())
        {
            self.writes.truncate(memory.writes);
            self.undone = memory.undone;
            self.noops = memory.noops;
            self.acted = memory.acted;
            self.created = memory.created;
            self.marks = memory.marks;
        }
        self.park.steps.clear();
        self.park.calls.clear();
        self.park.call = None;
        self.park.before = None;
        self.park.pending = None;
        if let Ok(world) = self.load_world() {
            self.park.world = Some(world.clone());
            self.world = world;
        }
    }

    /// The member dismissed the card: the vault is untouched and the session is as it was before
    /// the turn. `false` when `id` is not the pending write.
    pub fn dismiss(&mut self, id: &str) -> bool {
        if self
            .park
            .pending
            .as_ref()
            .is_none_or(|pending| pending.id != id)
        {
            return false;
        }
        self.discard();
        true
    }

    /// The member tapped the card: run the steps through the door, in order, with a key per step
    /// so a confirm sent twice writes once. The after-write observation is read back from the
    /// vault, not from the patch. See [`Confirmed`].
    pub fn confirm(&mut self, id: &str) -> Confirmed {
        if let Some((done, outcome)) = &self.park.confirmed
            && done == id
        {
            return outcome.clone();
        }
        let Some(pending) = self.park.pending.clone().filter(|pending| pending.id == id) else {
            return Confirmed::Unknown;
        };
        // A SECRET THE MEMBER TYPED NEEDS LOCKER OPEN: nothing has run, so the card stays.
        if pending
            .steps
            .iter()
            .any(|step| self.door.locked_for(step.act.command, &step.input))
        {
            return Confirmed::Locked;
        }
        let outcome = self.run_pending(&pending);
        // the pending write is answered either way: a stale or refused one is not offered again
        self.park.steps.clear();
        self.park.calls.clear();
        self.park.before = None;
        self.park.pending = None;
        if !matches!(outcome, Confirmed::Done { .. }) {
            if let Some(memory) = self.park.memory.take() {
                self.writes.truncate(memory.writes);
                self.undone = memory.undone;
                self.noops = memory.noops;
                self.acted = memory.acted;
                self.created = memory.created;
                self.marks = memory.marks;
            }
            if let Ok(world) = self.load_world() {
                self.park.world = Some(world.clone());
                self.world = world;
            }
        }
        self.park.confirmed = Some((id.to_owned(), outcome.clone()));
        outcome
    }

    fn run_pending(&mut self, pending: &PendingWrite) -> Confirmed {
        self.sealed_moves.clear();
        for step in &pending.steps {
            self.note_sealed_moves(step.act.command, &step.input);
        }
        let Ok(fresh) = self.load_world() else {
            return Confirmed::Refused {
                step: 0,
                command: String::new(),
                predicate: "door".to_owned(),
                reason: "the vault could not be read".to_owned(),
                landed: 0,
            };
        };
        let stale: Vec<String> = pending
            .base
            .iter()
            .filter(|(key, print)| fingerprint(&fresh, key) != **print)
            .map(|(key, _)| {
                let name = fresh
                    .rows
                    .get(key)
                    .or_else(|| pending.before.rows.get(key))
                    .map_or_else(String::new, |row| row.name.clone());
                format!("{} {name}", key.0.name())
            })
            .collect();
        if !stale.is_empty() {
            return Confirmed::Stale { rows: stale };
        }
        let mut aliases: BTreeMap<String, String> = BTreeMap::new();
        let mut landed = 0;
        let mut undo: Vec<Inverse> = Vec::new();
        let mut texts = Vec::new();
        let mut before = pending.before.clone();
        // the steps run call by call, and the vault is read after each call, as a run reads it: a
        // call's lines are the vault's own change from the call before
        let rounds = pending.calls.len()
            + usize::from(pending.steps.iter().any(|s| s.call >= pending.calls.len()));
        for round in 0..rounds {
            for (index, step) in pending.steps.iter().enumerate() {
                if step.call.min(pending.calls.len()) != round {
                    continue;
                }
                let mut input = step.input.clone();
                substitute(&mut input, &aliases);
                self.door.advance();
                let key = format!("{}:{index}", pending.id);
                let refusal = |predicate: String, reason: String| Confirmed::Refused {
                    step: index,
                    command: step.act.command.to_owned(),
                    predicate,
                    reason,
                    landed,
                };
                match self.door.act_keyed(&key, &step.act, input) {
                    Ok(ran) if ran.ok => {
                        // an id the patch made up for a row the vault names itself is the vault's now
                        if let (Some(parked), Some(real)) =
                            (step.output.as_object(), ran.output.as_object())
                        {
                            for (name, parked) in parked {
                                if let (Some(parked), Some(real)) =
                                    (parked.as_str(), real.get(name).and_then(Value::as_str))
                                    && parked != real
                                {
                                    aliases.insert(parked.to_owned(), real.to_owned());
                                }
                            }
                        }
                        // One entry per write, so the card has one line for each; a write with no inverse is
                        // an empty one, which draws its line without an Undo key.
                        undo.push(ran.inverse.unwrap_or_default());
                        landed += 1;
                    }
                    Ok(ran) => {
                        return refusal(
                            ran.predicate.unwrap_or_default(),
                            ran.reason.unwrap_or_default(),
                        );
                    }
                    Err(error) => return refusal("door".to_owned(), error),
                }
            }
            let Ok(after) = self.load_world() else {
                return Confirmed::Refused {
                    step: landed,
                    command: String::new(),
                    predicate: "door".to_owned(),
                    reason: "the vault could not be read after the write".to_owned(),
                    landed,
                };
            };
            self.remap(&aliases);
            self.world = after.clone();
            self.park.world = Some(after.clone());
            if let Some(call) = pending.calls.get(round) {
                let mut text = call.text.clone();
                for (key, n, shown) in &call.lines {
                    let key = (
                        key.0,
                        aliases
                            .get(&key.1)
                            .cloned()
                            .unwrap_or_else(|| key.1.clone()),
                    );
                    let line = self.change_line(call.verb, &before, &key, *n);
                    text = text.replacen(shown.as_str(), &line, 1);
                }
                texts.push(text);
            }
            before = after;
        }
        let diff = self.diff_since(&pending.before);
        Confirmed::Done {
            text: texts.join("\n"),
            diff: self.diff_json(&diff),
            steps: pending.steps.len(),
            undo,
        }
    }

    /// A row the patch gave an id the vault replaced keeps its `#n` and its place in the undo
    /// memory.
    fn remap(&mut self, aliases: &BTreeMap<String, String>) {
        if aliases.is_empty() {
            return;
        }
        let rename = |key: &mut Key| {
            if let Some(real) = aliases.get(&key.1) {
                key.1.clone_from(real);
            }
        };
        let numbers = std::mem::take(&mut self.numbers);
        self.numbers = numbers
            .into_iter()
            .map(|(mut key, n)| {
                rename(&mut key);
                (key, n)
            })
            .collect();
        self.by_number.iter_mut().for_each(rename);
        for result in &mut self.results {
            result.keys.iter_mut().for_each(rename);
        }
        for (_, inverses, _) in &mut self.writes {
            for inverse in inverses {
                substitute(&mut inverse.input, aliases);
                rename(&mut inverse.key);
            }
        }
    }
}
