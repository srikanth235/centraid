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
//! * The refusals the runtime acts on (`Session::refusal`, `compose_busy_conflict`): the id of
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

use crate::native::dates::Stamp;
use crate::native::door::{Call, Inverse, Ran};
use crate::native::meta::{Kind, Verb, Via};
use crate::native::world::local_stamp;
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

/// Whether a verb deletes, purges, merges, unfollows, removes or cancels: the writes a card asks twice for.
#[must_use]
pub fn destructive_verb(verb: &str) -> bool {
    matches!(
        verb,
        "delete" | "remove_from" | "cancel" | "purge" | "empty_trash" | "merge" | "unfollow"
    )
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
pub(crate) struct Cx<'a> {
    pub now: String,
    pub mint: &'a dyn Fn() -> String,
    /// [`Writes::Shadow`]: the output of the same command run for real.
    pub real: Option<&'a Value>,
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

fn int(input: &Value, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

impl Cx<'_> {
    /// A new id: the real run's when it made one, else a fresh one.
    fn id(&self, key: &str) -> String {
        self.real
            .and_then(|real| real.get(key))
            .and_then(Value::as_str)
            .map_or_else(|| (self.mint)(), str::to_owned)
    }

    fn stamp(&self) -> Option<Stamp> {
        Stamp::parse(&self.now)
    }
}

/// How long a trashed row stays restorable.
const PURGE_MS: i64 = 30 * 86_400_000;

/// The instant a row trashed now is purged, in the shape the column holds.
fn purge_at(now: &str) -> String {
    let millis = centraid_vault::clock::parse_iso_ms(now).unwrap_or_default();
    centraid_vault::clock::format_iso_ms(millis + PURGE_MS)
}

fn live<'w>(world: &'w World, kind: Kind, id: &str) -> Option<&'w Row> {
    world
        .rows
        .get(&(kind, id.to_owned()))
        .filter(|row| !row.trashed)
}

fn put(row: &mut Row, field: &'static str, value: Option<Val>) {
    match value {
        Some(value) => {
            row.fields.insert(field, value);
        }
        None => {
            row.fields.remove(field);
        }
    }
}

fn nonempty(text: &str) -> Option<Val> {
    (!text.is_empty()).then(|| Val::Text(text.to_owned()))
}

fn new_row(kind: Kind, id: &str, name: &str, cx: &Cx) -> Row {
    Row {
        kind,
        id: id.to_owned(),
        name: name.to_owned(),
        date: None,
        fields: BTreeMap::new(),
        trashed: false,
        created: cx.now.clone(),
        updated: cx.now.clone(),
        extra: BTreeMap::new(),
    }
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

/// An event's `date` and `duration` from its stored span, as the loader reads them.
fn shape_event(row: &mut Row, start: &str, end: Option<&str>) {
    crate::native::world::shape_event(row, Stamp::parse(start), end.and_then(Stamp::parse));
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
        "person.add" => person_add(world, cx, input),
        "person.edit" => person_edit(world, cx, input),
        "person.move" => person_move(world, cx, input),
        "person.add_note" => person_add_note(world, cx, input),
        "person.add_task" => person_add_task(world, cx, input),
        "person.add_gift" => person_add_gift(world, cx, input),
        "person.add_journal_entry" => person_add_journal_entry(world, cx, input),
        "person.add_date" => person_add_date(world, cx, input),
        "person.add_relationship" => person_add_relationship(world, input),
        "person.save_contact_point" => person_save_contact_point(world, cx, input),
        "person.remove_contact_point" => person_remove_contact_point(world, input),
        "person.merge" => person_merge(world, cx, input),
        "person.log_interaction" => {
            let id = text(input, "id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Person, id.to_owned())) {
                Some(row) if !row.trashed => {
                    row.date = cx.stamp();
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"interaction_id": cx.id("interaction_id")})))
                }
                _ => Ok(refused("touch_is_about_a_person", &gone(world, id))),
            }
        }
        "task.add" => task_add(world, cx, input),
        "task.edit" => task_edit(world, cx, input),
        "task.complete" | "task.reopen" | "task.cancel" => task_status(world, cx, input, command),
        "task.organize" => task_organize(world, cx, input),
        "event.propose" => event_propose(world, cx, input),
        "event.edit" => event_edit(world, cx, input),
        "event.edit_occurrence" => event_edit_occurrence(world, cx, input),
        "event.respond" => event_respond(world, input),
        "event.cancel" => {
            let id = text(input, "id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Event, id.to_owned())) {
                Some(row) if !row.trashed => {
                    row.fields.insert("status", Val::Enum("cancelled"));
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"id": id})))
                }
                _ => Ok(refused("event_is_live", &gone(world, id))),
            }
        }
        "note.create" => note_create(world, cx, input),
        "note.edit" => note_edit(world, cx, input),
        "note.move" => note_move(world, cx, input),
        "note.restore_version" => restore_version(world, cx, input, Kind::Note),
        "document.create_text" | "document.add" => document_create(world, cx, input),
        "document.edit" => document_edit(world, cx, input),
        "document.replace" => document_edit(world, cx, input),
        "document.move" => document_move(world, cx, input),
        "document.restore_version" => restore_version(world, cx, input, Kind::Document),
        "container.create" => container_create(world, cx, input),
        "container.style" => container_style(world, cx, input),
        "container.move" => container_move(world, cx, input),
        "entity.retitle" => retitle(world, cx, input),
        "entity.trash" => trash_entity(world, bin, cx, input),
        "entity.restore" => restore_entity(world, bin, cx, input),
        "entity.purge" => purge_entity(world, input),
        "entity.empty_trash" => empty_trash(world, cx, input),
        "flag.set" | "flag.clear" => flag_entity(world, input, command == "flag.set"),
        "tag.add" | "tag.remove" => tag_entity(world, input),
        "tag.color" => tag_color(input),
        "edge.add" | "edge.remove" => edge_entity(world, input, command == "edge.add"),
        "follow.stop" => follow_stop(world, input),
        "locker.add_item" => locker_add(world, cx, input),
        "locker.edit_item" => locker_edit(world, cx, input),
        "locker.duplicate_item" => locker_duplicate(world, cx, input),
        "locker.set_field" => locker_set_field(world, cx, input),
        "locker.remove_field" => locker_remove_field(world, input),
        "locker.set_addresses" => locker_set_addresses(world, input),
        "locker.set_passkey" => locker_set_passkey(world, cx, input),
        "locker.clear_passkey" => locker_clear_passkey(world, input),
        "locker.set_memo" => locker_set_memo(world, cx, input),
        "locker.mark_used" => Ok(ok(
            json!({"item_id": text(input, "item_id").unwrap_or_default()}),
        )),
        "workout.log" => workout_log(world, cx, input),
        "workout.edit" => workout_edit(world, cx, input),
        "measurement.log" => measurement_log(world, cx, input),
        "measurement.clear" => measurement_clear(world, input),
        "account.add" => account_add(world, cx, input),
        "category.add" => category_add(world, cx, input),
        "category.merge" => category_merge(world, input),
        "account.edit" => account_edit(world, cx, input),
        "account.set_opening" => account_set_opening(world, cx, input),
        "checkpoint.record" => checkpoint_record(world, input),
        "budget.set" => budget_set(world, input),
        "budget.set_carry" => budget_set_carry(world, input),
        "txn.edit" => txn_edit(world, cx, input),
        "txn.categorize" => txn_categorize(world, cx, input),
        "rule.add" => rule_add(world, cx, input),
        "rule.edit" => rule_edit(world, cx, input),
        "rule.delete" => rule_delete(world, input),
        "rule.apply" => Ok(ok(json!({"matched": 0, "recategorised": 0, "renamed": 0}))),
        "txn.link_transfer" | "txn.unlink_transfer" => {
            transfer(world, input, command == "txn.link_transfer")
        }
        "album.set_cover" => album_set_cover(world, cx, input),
        "photo.add" => photo_add(world, cx, input),
        "photo.edit" => photo_edit(world, cx, input),
        "photo.set_place" => photo_set_place(world, cx, input),
        "place.add" => place_add(world, cx, input),
        "account.remember_layout"
        | "document.export_zip"
        | "event.export_ics"
        | "health.export_csv"
        | "locker.export"
        | "note.export"
        | "note.import"
        | "person.export_vcf"
        | "person.import_vcf"
        | "photo.export_zip"
        | "task.export_ics"
        | "txn.export_csv"
        | "follow.calendar"
        | "follow.contacts"
        | "follow.health"
        | "follow.reminders"
        | "follow.statement"
        | "measurement.record" => Ok(ok(json!({"ok": true}))),
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
fn is_container(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::Album
            | Kind::Notebook
            | Kind::Folder
            | Kind::List
            | Kind::Calendar
            | Kind::PeopleList
            | Kind::Section
    )
}

/// The kinds that leave the model's world when they go to the trash: the containers, and a Money
/// transaction (its read is the live window, so a trashed line is in no read the model has, #1185).
fn leaves_when_trashed(kind: Kind) -> bool {
    is_container(kind) || kind == Kind::Transaction
}

/// What goes to the trash with a holder, and comes back with it (the vault's `members`): a
/// notebook's notes and notebooks, a folder's documents and folders, a list's tasks, a task's
/// subtasks, and what was written about one person alone (a note or an event; a task about them
/// stays).
fn members(world: &World, holder: &Key) -> Vec<Key> {
    let mut out: Vec<Key> = match holder.0 {
        Kind::Notebook | Kind::Folder => world
            .rows
            .iter()
            .filter(|(key, row)| key.0 == holder.0 && row.extra.get("parent") == Some(&holder.1))
            .map(|(key, _)| key.clone())
            .collect(),
        Kind::List => world
            .rows
            .iter()
            .filter(|(key, row)| {
                key.0 == Kind::Section && row.extra.get("list_id") == Some(&holder.1)
            })
            .map(|(key, _)| key.clone())
            .collect(),
        _ => Vec::new(),
    };
    let held: &[Via] = match holder.0 {
        Kind::Notebook => &[Via::Entry],
        Kind::Folder => &[Via::FolderColumn],
        Kind::List => &[Via::ListColumn],
        Kind::Task => &[Via::Subtask],
        _ => &[],
    };
    out.extend(
        world
            .edges
            .iter()
            .filter(|edge| edge.from == *holder && held.contains(&edge.via))
            .map(|edge| edge.to.clone()),
    );
    if holder.0 == Kind::Person {
        for edge in world
            .edges
            .iter()
            .filter(|edge| edge.via == Via::About && edge.to == *holder)
        {
            let alone = world.edges.iter().all(|other| {
                other.via != Via::About || other.from != edge.from || other.to == *holder
            });
            if alone && matches!(edge.from.0, Kind::Note | Kind::Event) {
                out.push(edge.from.clone());
            }
        }
    }
    out
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
    sync_dependents_trash(world, key, Some(cx));
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
    sync_dependents_trash(world, key, None);
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

/// A purge, as far as the model reads one: an area made for a list goes, and the lists in it
/// are out of any area; any other row that is in the trash goes.
fn purge_entity(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    if let Some(at) = world.areas.iter().position(|(area, _)| *area == id) {
        world.areas.remove(at);
        for row in world.rows.values_mut().filter(|row| row.kind == Kind::List) {
            if row.extra.get("area_id") == Some(&id) {
                row.extra.remove("area_id");
                row.fields.remove("area");
            }
        }
        return Ok(ok(json!({"purged": [id]})));
    }
    match key_of(world, &id) {
        Some(key) if world.rows[&key].trashed => {
            world.rows.remove(&key);
            purge_dependents(world, &key);
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
    if key.0 != Kind::Photo && title.is_empty() {
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
        if key.0 == Kind::JournalEntry {
            row.fields.insert("mood", Val::Text(row.name.clone()));
        }
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"id": id})))
}

/// Mirror parent trash/restore onto dependent non-entity rows (`ContactPoint`, `LockerField`,
/// `LockerPasskey`) as `World::load` reads them from their parent entity.
fn sync_dependents_trash(world: &mut World, parent: &Key, trashed: Option<&Cx>) {
    let child_keys: Vec<Key> = match parent.0 {
        Kind::Person => world
            .rows
            .iter()
            .filter(|(k, r)| {
                k.0 == Kind::ContactPoint && r.extra.get("person_id") == Some(&parent.1)
            })
            .map(|(k, _)| k.clone())
            .collect(),
        Kind::LockerItem => world
            .rows
            .iter()
            .filter(|(k, r)| {
                (k.0 == Kind::LockerField && r.extra.get("item_id") == Some(&parent.1))
                    || (k.0 == Kind::LockerPasskey && k.1 == parent.1)
            })
            .map(|(k, _)| k.clone())
            .collect(),
        _ => Vec::new(),
    };
    for key in child_keys {
        if let Some(row) = world.rows.get_mut(&key) {
            row.trashed = trashed.is_some();
            if let Some(cx) = trashed {
                row.updated = cx.now.clone();
            }
        }
    }
}

fn purge_dependents(world: &mut World, parent: &Key) {
    match parent.0 {
        Kind::Person => {
            world.rows.retain(|k, r| {
                !(k.0 == Kind::ContactPoint && r.extra.get("person_id") == Some(&parent.1))
            });
        }
        Kind::LockerItem => {
            world.rows.retain(|k, r| {
                !((k.0 == Kind::LockerField && r.extra.get("item_id") == Some(&parent.1))
                    || (k.0 == Kind::LockerPasskey && k.1 == parent.1))
            });
        }
        _ => {}
    }
}

fn empty_trash(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let kind_filter = text(input, "kind");
    let due_only = flag_or(input, "due_only", false);
    let keys: Vec<Key> = world
        .rows
        .iter()
        .filter(|(_, row)| {
            row.trashed
                && (!due_only
                    || row
                        .extra
                        .get("purge_at")
                        .is_some_and(|at| at.as_str() <= cx.now.as_str()))
                && kind_filter.is_none_or(|want| {
                    crate::native::world::vault_kind_of(row.kind) == Some(want)
                        || (want == "event" && matches!(row.kind, Kind::Event | Kind::ImportantDate))
                        || (want == "task" && matches!(row.kind, Kind::Task | Kind::Gift))
                        || (want == "note" && matches!(row.kind, Kind::Note | Kind::JournalEntry))
                })
        })
        .map(|(k, _)| k.clone())
        .collect();
    let count = keys.len();
    let remove_set: std::collections::BTreeSet<Key> = keys.iter().cloned().collect();
    for key in &keys {
        world.rows.remove(key);
        purge_dependents(world, key);
    }
    unlink(world, |edge| {
        !(remove_set.contains(&edge.from) || remove_set.contains(&edge.to))
    });
    Ok(ok(json!({"purged": count, "released": [], "more": false})))
}

fn flag_entity(world: &mut World, input: &Value, on: bool) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let flag = text(input, "flag").unwrap_or("starred");
    let Some(key) = key_of(world, id).filter(|key| !world.rows[key].trashed) else {
        return Ok(refused("entity_takes_a_flag", &gone(world, id)));
    };
    if let Some(row) = world.rows.get_mut(&key) {
        match flag {
            "starred" => {
                row.fields.insert("starred", Val::Bool(on));
            }
            "pinned" => {
                row.fields.insert("pinned", Val::Bool(on));
            }
            "archived" => {
                if on {
                    row.extra.insert("archived", "true".to_owned());
                } else {
                    row.extra.remove("archived");
                }
            }
            _ => {}
        }
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

fn tag_color(input: &Value) -> Result<Ran, String> {
    let Some(label) = text(input, "label").filter(|label| !label.trim().is_empty()) else {
        return Ok(refused(
            "label_is_a_word",
            "a label needs at least one character",
        ));
    };
    Ok(ok(json!({"label": label, "color": input.get("color").cloned().unwrap_or(Value::Null)})))
}

fn follow_stop(world: &mut World, input: &Value) -> Result<Ran, String> {
    if text(input, "system") == Some("health") {
        world.health_store = None;
    }
    Ok(ok(json!({"stopped": true, "forgotten": 0})))
}

/// An edge the model reads: a photograph in an album (`contains`) or of a person (`depicts`), a line with a person (`with`), what a note, task, event or document is
/// `about`, and who attends an event.
fn edge_entity(world: &mut World, input: &Value, add: bool) -> Result<Ran, String> {
    let (from, to) = (
        text(input, "from").unwrap_or_default(),
        text(input, "to").unwrap_or_default(),
    );
    let rel = text(input, "rel");
    let via = match rel {
        Some("contains") => Via::Entry,
        Some("about") => Via::About,
        Some("with") => Via::With,
        Some("depicts") => Via::Depicts,
        Some("attendee") => Via::Attendee,
        Some("attached" | "links" | "related") => {
            if key_of(world, from).is_none() || key_of(world, to).is_none() {
                let predicate = if add {
                    "edge_joins_what_it_may"
                } else {
                    "edge_ends_exist"
                };
                return Ok(refused(predicate, "there is nothing with that id"));
            }
            return Ok(ok(json!({})));
        }
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

/// A text column that `null` empties.
fn text_or_clear(row: &mut Row, input: &Value, key: &str, field: &'static str) {
    match input.get(key) {
        Some(Value::String(value)) => put(row, field, nonempty(value)),
        Some(Value::Null) => put(row, field, None),
        _ => {}
    }
}

fn person_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    if key_of(world, &id).is_some() {
        return Ok(refused(
            "person_can_be_added",
            "a person already holds the id this write minted",
        ));
    }
    let mut row = new_row(
        Kind::Person,
        &id,
        text(input, "title").unwrap_or_default(),
        cx,
    );
    for (key, field) in [("role", "role"), ("nickname", "nickname"), ("met", "met")] {
        put(
            &mut row,
            field,
            nonempty(text(input, key).unwrap_or_default()),
        );
    }
    put(
        &mut row,
        "cadence",
        int(input, "cadence_days")
            .filter(|days| *days > 0)
            .map(Val::Num),
    );
    row.fields.insert("starred", Val::Bool(false));
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id})))
}

fn person_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Person, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("person_can_be_edited", &gone(world, id)));
    };
    if let Some(name) = text(input, "title") {
        row.name = name.to_owned();
    }
    for field in ["role", "nickname", "met"] {
        text_or_clear(row, input, field, field);
    }
    match input.get("cadence_days") {
        Some(Value::Null) => put(row, "cadence", None),
        Some(value) => put(
            row,
            "cadence",
            value.as_i64().filter(|days| *days > 0).map(Val::Num),
        ),
        None => {}
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn person_move(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    if live(world, Kind::Person, &id).is_none() {
        return Ok(refused("person_can_be_filed", &gone(world, &id)));
    }
    if let Some(list_id) = text(input, "list_id")
        && live(world, Kind::PeopleList, list_id).is_none()
    {
        return Ok(refused("person_can_be_filed", "there is no list with that id"));
    }
    if let Some(row) = world.rows.get_mut(&(Kind::Person, id.clone())) {
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"id": id, "list_id": input.get("list_id").cloned().unwrap_or(Value::Null)})))
}

fn headline(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .take(60)
        .collect()
}

fn person_add_note(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let person = text(input, "id").unwrap_or_default().to_owned();
    if live(world, Kind::Person, &person).is_none() {
        return Ok(refused("note_is_about_a_person", &gone(world, &person)));
    }
    let body = text(input, "text").unwrap_or_default();
    if body.trim().is_empty() {
        return Ok(refused("note_is_about_a_person", "there is nothing written"));
    }
    let id = cx.id("note_id");
    let title = headline(body);
    let mut row = new_row(Kind::Note, &id, &title, cx);
    row.date = local_stamp(&world.zone, &cx.now);
    put(&mut row, "body", nonempty(body));
    row.fields.insert("pinned", Val::Bool(false));
    row.fields.insert("starred", Val::Bool(false));
    world.rows.insert(row.key(), row);
    edge(world, (Kind::Note, id.clone()), (Kind::Person, person), Via::About);
    Ok(ok(json!({"note_id": id})))
}

fn person_add_task(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let person = text(input, "id").unwrap_or_default().to_owned();
    if live(world, Kind::Person, &person).is_none() {
        return Ok(refused("task_is_about_a_person", &gone(world, &person)));
    }
    let title = text(input, "text").unwrap_or_default().trim().to_owned();
    if title.is_empty() {
        return Ok(refused("task_is_about_a_person", "there is nothing written"));
    }
    let id = cx.id("task_id");
    let mut row = new_row(Kind::Task, &id, &title, cx);
    row.fields.insert("status", Val::Enum("open"));
    row.fields.insert("starred", Val::Bool(false));
    world.rows.insert(row.key(), row);
    edge(world, (Kind::Task, id.clone()), (Kind::Person, person), Via::About);
    Ok(ok(json!({"task_id": id})))
}

fn person_add_gift(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let person = text(input, "id").unwrap_or_default().to_owned();
    if live(world, Kind::Person, &person).is_none() {
        return Ok(refused("gift_is_for_a_person", &gone(world, &person)));
    }
    let title = text(input, "text").unwrap_or_default().trim().to_owned();
    if title.is_empty() {
        return Ok(refused("gift_is_for_a_person", "there is nothing written"));
    }
    let id = cx.id("task_id");
    let row = new_row(Kind::Gift, &id, &title, cx);
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"task_id": id})))
}

fn person_add_journal_entry(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let mood = text(input, "mood").unwrap_or_default().trim().to_owned();
    let body = text(input, "text").unwrap_or_default();
    if mood.is_empty() || body.trim().is_empty() {
        return Ok(refused("entry_is_dated", "an entry needs a mood and words"));
    }
    let id = cx.id("entry_id");
    let mut row = new_row(Kind::JournalEntry, &id, &mood, cx);
    row.date = text(input, "entry_date")
        .and_then(Stamp::parse)
        .or_else(|| local_stamp(&world.zone, &cx.now));
    row.fields.insert("mood", Val::Text(mood));
    put(&mut row, "body", nonempty(body));
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"entry_id": id})))
}

fn person_add_date(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let person = text(input, "id").unwrap_or_default().to_owned();
    let label = text(input, "label").unwrap_or_default().trim().to_owned();
    let month_day = text(input, "month_day").unwrap_or_default().to_owned();
    if label.is_empty() {
        return Ok(refused("date_is_a_day", "a date needs a label"));
    }
    if live(world, Kind::Person, &person).is_none() {
        return Ok(refused("date_is_a_day", &gone(world, &person)));
    }
    if centraid_vault::model::fold_label(&label) == "birthday" {
        if let Some(row) = world.rows.get_mut(&(Kind::Person, person.clone())) {
            row.extra.insert("birthday", month_day);
            row.updated = cx.now.clone();
        }
        return Ok(ok(json!({"id": person})));
    }
    let id = cx.id("date_id");
    let year: i64 = cx.now.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(2000);
    let starts = format!("{year}-{month_day}");
    let mut row = new_row(Kind::ImportantDate, &id, &label, cx);
    row.date = Stamp::parse(&starts);
    row.extra.insert("dtstart", starts);
    row.extra.insert("timing", "all-day".to_owned());
    row.extra.insert("rrule", "FREQ=YEARLY".to_owned());
    if flag_or(input, "reminder_on", false) {
        row.fields.insert("reminders", Val::Num(0));
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"date_id": id})))
}

fn person_add_relationship(world: &mut World, input: &Value) -> Result<Ran, String> {
    let person = text(input, "id").unwrap_or_default();
    if live(world, Kind::Person, person).is_none() {
        return Ok(refused("relative_is_another_person", &gone(world, person)));
    }
    let related = text(input, "related_id").unwrap_or_default();
    Ok(ok(json!({"related_id": related})))
}

fn person_save_contact_point(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let person_id = text(input, "id").unwrap_or_default().to_owned();
    let Some(person_row) = live(world, Kind::Person, &person_id).cloned() else {
        return Ok(refused("person_is_live", &gone(world, &person_id)));
    };
    let channel = text(input, "kind").unwrap_or("phone").to_owned();
    let value = text(input, "value").unwrap_or_default().trim().to_owned();
    let preferred = flag_or(input, "preferred", false);
    let point_id = text(input, "point_id")
        .map(str::to_owned)
        .unwrap_or_else(|| cx.id("point_id"));
    if preferred {
        for (key, row) in world.rows.iter_mut() {
            if key.0 == Kind::ContactPoint
                && key.1 != point_id
                && row.extra.get("person_id") == Some(&person_id)
                && row.field("channel") == Some(&Val::Text(channel.clone()))
            {
                row.fields.insert("preferred", Val::Bool(false));
            }
        }
    }
    let mut row = new_row(Kind::ContactPoint, &point_id, &value, cx);
    row.created = person_row.created;
    row.updated = cx.now.clone();
    row.fields.insert("person_id", Val::Text(person_id.clone()));
    row.fields.insert("channel", Val::Text(channel));
    row.fields.insert("value", Val::Text(value));
    if let Some(label) = text(input, "label").filter(|s| !s.trim().is_empty()) {
        row.fields.insert("label", Val::Text(label.to_owned()));
    }
    row.fields.insert("preferred", Val::Bool(preferred));
    row.extra.insert("person_id", person_id);
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"point_id": point_id})))
}

fn person_remove_contact_point(world: &mut World, input: &Value) -> Result<Ran, String> {
    let point_id = text(input, "point_id").unwrap_or_default();
    let Some(removed) = world.rows.remove(&(Kind::ContactPoint, point_id.to_owned())) else {
        return Ok(refused(
            "contact_point_exists",
            "there is no contact point with that id",
        ));
    };
    let person_id = removed.extra.get("person_id").cloned().unwrap_or_default();
    Ok(ok(json!({"id": person_id})))
}

fn person_merge(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let from = text(input, "from").unwrap_or_default().to_owned();
    let into = text(input, "into").unwrap_or_default().to_owned();
    if from == into
        || live(world, Kind::Person, &from).is_none()
        || live(world, Kind::Person, &into).is_none()
    {
        return Ok(refused("both_are_people", "choose two distinct live people"));
    }
    let from_key = (Kind::Person, from.clone());
    let into_key = (Kind::Person, into.clone());
    world.rows.remove(&from_key);
    for row in world.rows.values_mut() {
        if row.kind == Kind::ContactPoint && row.extra.get("person_id") == Some(&from) {
            row.extra.insert("person_id", into.clone());
            row.fields.insert("person_id", Val::Text(into.clone()));
        }
    }
    for e in &mut world.edges {
        if e.from == from_key {
            e.from = into_key.clone();
        }
        if e.to == from_key {
            e.to = into_key.clone();
        }
    }
    world.edges.retain(|e| e.from != e.to);
    world.edges.sort();
    world.edges.dedup();
    if let Some(row) = world.rows.get_mut(&into_key) {
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"from": from, "into": into})))
}

// ---------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------

fn task_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let predicate = "task_has_a_title_and_a_model_that_holds";
    if key_of(world, &id).is_some() {
        return Ok(refused(predicate, "a task with that id already exists"));
    }
    if let Some(parent) = text(input, "parent_id") {
        let top_level = world.parent_of(&(Kind::Task, parent.to_owned())).is_none();
        let open = live(world, Kind::Task, parent)
            .is_some_and(|row| matches!(row.field("status"), Some(Val::Enum("open"))));
        if !(top_level && open) {
            return Ok(refused(
                predicate,
                "That parent is not an open, top-level task.",
            ));
        }
    }
    if let Some(project) = text(input, "project_id")
        && live(world, Kind::List, project).is_none()
    {
        return Ok(refused(predicate, "There is no such list."));
    }
    let mut row = new_row(
        Kind::Task,
        &id,
        text(input, "title").unwrap_or_default(),
        cx,
    );
    row.fields.insert("status", Val::Enum("open"));
    row.date = text(input, "due").and_then(Stamp::parse);
    put(&mut row, "effort", int(input, "effort_min").map(Val::Num));
    put(
        &mut row,
        "priority",
        int(input, "priority")
            .filter(|value| *value > 0)
            .map(Val::Num),
    );
    put(
        &mut row,
        "description",
        nonempty(text(input, "description").unwrap_or_default()),
    );
    if let Some(rule) = text(input, "rule") {
        row.extra.insert("rrule", rule.to_owned());
    }
    row.fields.insert("starred", Val::Bool(false));
    world.rows.insert(row.key(), row);
    if let Some(parent) = text(input, "parent_id") {
        edge(
            world,
            (Kind::Task, parent.to_owned()),
            (Kind::Task, id.clone()),
            Via::Subtask,
        );
    }
    if let Some(project) = text(input, "project_id") {
        edge(
            world,
            (Kind::List, project.to_owned()),
            (Kind::Task, id.clone()),
            Via::ListColumn,
        );
    }
    Ok(ok(json!({"id": id})))
}

fn task_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Task, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused(
            "task_is_live_and_a_model_that_holds",
            &gone(world, id),
        ));
    };
    if let Some(title) = text(input, "title") {
        row.name = title.to_owned();
    }
    text_or_clear(row, input, "description", "description");
    match input.get("due") {
        Some(Value::String(due)) => row.date = Stamp::parse(due),
        Some(Value::Null) => row.date = None,
        _ => {}
    }
    if let Some(priority) = int(input, "priority") {
        put(
            row,
            "priority",
            Some(priority).filter(|value| *value > 0).map(Val::Num),
        );
    }
    match input.get("effort_min") {
        Some(Value::Null) => put(row, "effort", None),
        Some(value) => put(row, "effort", value.as_i64().map(Val::Num)),
        None => {}
    }
    match input.get("rule") {
        Some(Value::String(rule)) => {
            row.extra.insert("rrule", rule.clone());
        }
        Some(Value::Null) => {
            row.extra.remove("rrule");
        }
        _ => {}
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn task_status(world: &mut World, cx: &Cx, input: &Value, command: &str) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let (model, vault) = match command {
        "task.complete" => ("completed", "done"),
        "task.cancel" => ("cancelled", "cancelled"),
        _ => ("open", "open"),
    };
    let stamp = cx.stamp();
    let key = if live(world, Kind::Task, id).is_some() {
        (Kind::Task, id.to_owned())
    } else if live(world, Kind::Gift, id).is_some() {
        (Kind::Gift, id.to_owned())
    } else {
        return Ok(refused("task_is_live", &gone(world, id)));
    };
    if let Some(row) = world.rows.get_mut(&key) {
        if key.0 == Kind::Task && row.field("status") != Some(&Val::Enum(model)) {
            row.fields.insert("status", Val::Enum(model));
            // `done_at` exists iff the status says done
            put(
                row,
                "completed",
                (model == "completed")
                    .then_some(stamp)
                    .flatten()
                    .map(Val::Date),
            );
            row.updated = cx.now.clone();
        } else if key.0 == Kind::Gift {
            row.updated = cx.now.clone();
        }
    }
    Ok(ok(json!({"id": id, "status": vault})))
}

fn task_organize(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    let task = (Kind::Task, id.clone());
    let predicate = "task_is_live_and_a_model_that_holds";
    if live(world, Kind::Task, &id).is_none() {
        return Ok(refused(predicate, &gone(world, &id)));
    }
    if let Some(project) = text(input, "project_id")
        && live(world, Kind::List, project).is_none()
    {
        return Ok(refused(predicate, "There is no such list."));
    }
    if input.get("project_id").is_some() {
        unlink(world, |edge| {
            !(edge.via == Via::ListColumn && edge.to == task)
        });
        if let Some(project) = text(input, "project_id") {
            edge(
                world,
                (Kind::List, project.to_owned()),
                task.clone(),
                Via::ListColumn,
            );
        }
        if let Some(row) = world.rows.get_mut(&task) {
            row.updated = cx.now.clone();
        }
    }
    Ok(ok(json!({"id": id})))
}

// ---------------------------------------------------------------------
// events
// ---------------------------------------------------------------------

/// An event's `date` and `duration` from its stored span, as the loader reads them: an all-day
/// event is a day and no clock time.
fn shape_stored(row: &mut Row) {
    let start = row.extra.get("dtstart").cloned().unwrap_or_default();
    let end = row.extra.get("dtend").cloned();
    if row.extra.get("timing").map(String::as_str) == Some("all-day") {
        row.fields.remove("duration");
        row.date = Stamp::parse(&start).map(|start| Stamp {
            date: start.date,
            time: None,
        });
    } else {
        shape_event(row, &start, end.as_deref());
    }
}

/// Whether a timed, busy event clashes with one already on the calendar: the vault's reading.
fn span_clash(world: &World, start: &str, end: &str) -> bool {
    world.of_kind(Kind::Event).any(|event| {
        !event.trashed
            && event.field("status") != Some(&Val::Enum("cancelled"))
            && event.extra.get("timing").map(String::as_str) != Some("all-day")
            && event.extra.get("dtstart").is_some_and(|s| s.as_str() < end)
            && event.extra.get("dtend").is_none_or(|e| e.as_str() > start)
    })
}

fn event_propose(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let start = text(input, "starts").unwrap_or_default();
    let end = text(input, "ends");
    let timing = text(input, "timing").unwrap_or("floating");
    let predicate = "event_has_a_title_and_a_time";
    if key_of(world, &id).is_some() {
        return Ok(refused(predicate, "an event with that id already exists"));
    }
    if let Some(end) = end
        && end < start
    {
        return Ok(refused(predicate, "An event must end after it starts."));
    }
    if timing != "all-day"
        && flag_or(input, "busy", true)
        && let Some(end) = end
        && span_clash(world, start, end)
    {
        return Ok(refused(
            "no_busy_conflict",
            "This time conflicts with another event on your calendar.",
        ));
    }
    let mut row = new_row(
        Kind::Event,
        &id,
        text(input, "title").unwrap_or_default(),
        cx,
    );
    row.fields.insert(
        "status",
        Val::Enum(match text(input, "status") {
            Some("tentative") => "tentative",
            Some("cancelled") => "cancelled",
            _ => "confirmed",
        }),
    );
    put(
        &mut row,
        "description",
        nonempty(text(input, "description").unwrap_or_default()),
    );
    row.extra.insert("dtstart", start.to_owned());
    if let Some(end) = end {
        row.extra.insert("dtend", end.to_owned());
    }
    row.extra.insert("timing", timing.to_owned());
    if let Some(zone) = text(input, "zone") {
        row.extra.insert("zone", zone.to_owned());
    }
    if let Some(rule) = text(input, "rule") {
        row.extra.insert("rrule", rule.to_owned());
    }
    shape_stored(&mut row);
    world.rows.insert(row.key(), row);
    let attendees = input
        .get("attendees")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    for party in &attendees {
        edge(
            world,
            (Kind::Event, id.clone()),
            (Kind::Person, (*party).to_owned()),
            Via::Attendee,
        );
    }
    Ok(ok(json!({"id": id, "attendees": attendees.len()})))
}

fn flag_or(input: &Value, key: &str, default: bool) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn event_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let predicate = "event_is_live_and_its_change_resolves";
    let key = if live(world, Kind::Event, id).is_some() {
        (Kind::Event, id.to_owned())
    } else if live(world, Kind::ImportantDate, id).is_some() {
        (Kind::ImportantDate, id.to_owned())
    } else {
        return Ok(refused(predicate, &gone(world, id)));
    };
    let row = world
        .rows
        .get_mut(&key)
        .ok_or_else(|| "row was just verified".to_owned())?;
    if key.0 == Kind::ImportantDate {
        if let Some(title) = text(input, "title") {
            row.name = title.to_owned();
        }
        if let Some(reminders) = input.get("reminders").and_then(Value::as_array) {
            if let Some(first) = reminders.first().and_then(Value::as_i64) {
                row.fields.insert("reminders", Val::Num(first));
            } else {
                row.fields.remove("reminders");
            }
        }
        row.updated = cx.now.clone();
        return Ok(ok(json!({"id": id})));
    }
    if let Some(title) = text(input, "title") {
        row.name = title.to_owned();
    }
    text_or_clear(row, input, "description", "description");
    if let Some(status) = text(input, "status") {
        let model = match status {
            "tentative" => "tentative",
            "cancelled" => "cancelled",
            _ => "confirmed",
        };
        row.fields.insert("status", Val::Enum(model));
    }
    let mut moved = false;
    if let Some(start) = text(input, "starts") {
        row.extra.insert("dtstart", start.to_owned());
        moved = true;
    }
    match input.get("ends") {
        Some(Value::String(end)) => {
            row.extra.insert("dtend", end.clone());
            moved = true;
        }
        Some(Value::Null) => {
            row.extra.remove("dtend");
            moved = true;
        }
        _ => {}
    }
    if let Some(timing) = text(input, "timing") {
        row.extra.insert("timing", timing.to_owned());
        moved = true;
    }
    match input.get("zone") {
        Some(Value::String(zone)) => {
            row.extra.insert("zone", zone.clone());
        }
        Some(Value::Null) => {
            row.extra.remove("zone");
        }
        _ => {}
    }
    if moved {
        let (start, end) = (
            row.extra.get("dtstart").cloned().unwrap_or_default(),
            row.extra.get("dtend").cloned(),
        );
        if end.as_deref().is_some_and(|end| end < start.as_str()) {
            return Ok(refused(predicate, "An event must end after it starts."));
        }
        shape_stored(row);
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn event_edit_occurrence(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let scope = text(input, "scope").unwrap_or("occurrence");
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Event, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("event_is_live", &gone(world, id)));
    };
    if text(input, "action") == Some("cancel") {
        row.fields.insert("status", Val::Enum("cancelled"));
    }
    if let Some(title) = text(input, "title") {
        row.name = title.to_owned();
    }
    text_or_clear(row, input, "description", "description");
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id, "scope": scope})))
}

fn event_respond(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    if live(world, Kind::Event, id).is_none() {
        return Ok(refused("event_is_live", &gone(world, id)));
    }
    let state = text(input, "state").unwrap_or("accepted");
    Ok(ok(json!({"id": id, "state": state})))
}

// ---------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------

fn note_create(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let predicate = "note_has_a_title_a_body_within_budget_and_a_notebook";
    if key_of(world, &id).is_some() {
        return Ok(refused(
            predicate,
            "a note already holds the id this write minted",
        ));
    }
    if let Some(notebook) = text(input, "notebook_id")
        && !world
            .rows
            .contains_key(&(Kind::Notebook, notebook.to_owned()))
    {
        return Ok(refused(predicate, "there is no notebook with that id"));
    }
    let mut row = new_row(
        Kind::Note,
        &id,
        text(input, "title").unwrap_or_default(),
        cx,
    );
    row.date = Stamp::parse(&cx.now);
    put(
        &mut row,
        "body",
        nonempty(text(input, "body").unwrap_or_default()),
    );
    row.fields.insert("pinned", Val::Bool(false));
    row.fields.insert("starred", Val::Bool(false));
    world.rows.insert(row.key(), row);
    if let Some(notebook) = text(input, "notebook_id") {
        edge(
            world,
            (Kind::Notebook, notebook.to_owned()),
            (Kind::Note, id.clone()),
            Via::Entry,
        );
    }
    Ok(ok(json!({"id": id})))
}

fn note_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Note, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused(
            "note_is_live_and_body_within_budget",
            &gone(world, id),
        ));
    };
    if let Some(body) = text(input, "body") {
        put(row, "body", nonempty(body));
    }
    if let Some(title) = text(input, "title") {
        row.name = title.to_owned();
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn note_move(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    let note = (Kind::Note, id.clone());
    let predicate = "note_is_live_and_notebook_exists";
    if live(world, Kind::Note, &id).is_none() {
        return Ok(refused(predicate, &gone(world, &id)));
    }
    let notebook = text(input, "notebook_id").map(|notebook| (Kind::Notebook, notebook.to_owned()));
    if let Some(notebook) = &notebook
        && !world.rows.contains_key(notebook)
    {
        return Ok(refused(predicate, "there is no notebook with that id"));
    }
    unlink(world, |edge| !(edge.via == Via::Entry && edge.to == note));
    if let Some(notebook) = notebook {
        edge(world, notebook, note.clone(), Via::Entry);
    }
    if let Some(row) = world.rows.get_mut(&note) {
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"id": id})))
}

// ---------------------------------------------------------------------
// documents and containers
// ---------------------------------------------------------------------

fn document_create(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let predicate = "document_has_a_name_words_within_budget_and_a_folder";
    if key_of(world, &id).is_some() {
        return Ok(refused(
            predicate,
            "a document already holds the id this write minted",
        ));
    }
    if let Some(folder) = text(input, "folder_id")
        && !world.rows.contains_key(&(Kind::Folder, folder.to_owned()))
    {
        return Ok(refused(predicate, "there is no folder with that id"));
    }
    let mut row = new_row(
        Kind::Document,
        &id,
        text(input, "title").unwrap_or_default(),
        cx,
    );
    row.date = Stamp::parse(&cx.now);
    row.fields.insert("starred", Val::Bool(false));
    world.rows.insert(row.key(), row);
    if let Some(folder) = text(input, "folder_id") {
        edge(
            world,
            (Kind::Folder, folder.to_owned()),
            (Kind::Document, id.clone()),
            Via::FolderColumn,
        );
    }
    Ok(ok(json!({"id": id})))
}

fn document_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Document, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("document_is_live", &gone(world, id)));
    };
    if let Some(title) = text(input, "title").filter(|s| !s.trim().is_empty()) {
        row.name = title.trim().to_owned();
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn restore_version(world: &mut World, cx: &Cx, input: &Value, kind: Kind) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(kind, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("entity_is_live", &gone(world, id)));
    };
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id, "restored": true})))
}

fn document_move(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    let document = (Kind::Document, id.clone());
    let predicate = "document_is_live_and_folder_exists";
    if live(world, Kind::Document, &id).is_none() {
        return Ok(refused(predicate, &gone(world, &id)));
    }
    let folder = text(input, "folder_id").map(|folder| (Kind::Folder, folder.to_owned()));
    if let Some(folder) = &folder
        && !world.rows.contains_key(folder)
    {
        return Ok(refused(predicate, "there is no folder with that id"));
    }
    unlink(world, |edge| {
        !(edge.via == Via::FolderColumn && edge.to == document)
    });
    if let Some(folder) = folder {
        edge(world, folder, document.clone(), Via::FolderColumn);
    }
    if let Some(row) = world.rows.get_mut(&document) {
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"id": id})))
}

fn container_create(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let title = text(input, "title").unwrap_or_default();
    let predicate = "container_has_a_name_and_a_place";
    if key_of(world, &id).is_some() || world.areas.iter().any(|(area, _)| *area == id) {
        return Ok(refused(
            predicate,
            "something already holds the id this write minted",
        ));
    }
    let kind = match text(input, "kind") {
        Some("album") => Kind::Album,
        Some("notebook") => Kind::Notebook,
        Some("folder") => Kind::Folder,
        Some("project") => Kind::List,
        Some("calendar") => Kind::Calendar,
        Some("list") => Kind::PeopleList,
        Some("section") => Kind::Section,
        // an area is a container the model has no kind for: its lists carry its title
        Some("area") => {
            world.areas.push((id.clone(), title.to_owned()));
            return Ok(ok(json!({"id": id})));
        }
        other => {
            return Err(format!(
                "error: park has no patch for a container of {other:?}"
            ));
        }
    };
    let parent = text(input, "parent").map(str::to_owned);
    let mut row = new_row(kind, &id, title, cx);
    if matches!(kind, Kind::List | Kind::Calendar) {
        if let Some(color) = text(input, "color").filter(|s| !s.is_empty()) {
            row.fields.insert("color", Val::Text(color.to_owned()));
        }
        if let Some(icon) = text(input, "icon").filter(|s| !s.is_empty()) {
            row.fields.insert("icon", Val::Text(icon.to_owned()));
        }
    }
    if kind == Kind::Section {
        let pos = input
            .get("position")
            .and_then(Value::as_f64)
            .map(|p| p.round() as i64)
            .unwrap_or_else(|| {
                world
                    .rows
                    .values()
                    .filter(|r| r.kind == Kind::Section && r.extra.get("list_id") == parent.as_ref())
                    .filter_map(|r| match r.field("position") {
                        Some(Val::Num(n)) => Some(*n),
                        _ => None,
                    })
                    .max()
                    .unwrap_or(0)
                    + 1
            });
        row.fields.insert("position", Val::Num(pos));
    }
    if let Some(parent) = parent {
        match kind {
            Kind::List => set_area(world, &mut row, Some(&parent)),
            Kind::Section => {
                if let Some(list) = world.rows.get(&(Kind::List, parent.clone())) {
                    put(&mut row, "list", nonempty(&list.name));
                }
                row.extra.insert("list_id", parent);
            }
            _ => {
                row.extra.insert("parent", parent);
            }
        }
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id})))
}

fn container_style(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(key) = key_of(world, id)
        .filter(|k| matches!(k.0, Kind::List | Kind::Calendar) && !world.rows[k].trashed)
    else {
        return Ok(refused("entity_is_live", &gone(world, id)));
    };
    if let Some(row) = world.rows.get_mut(&key) {
        text_or_clear(row, input, "color", "color");
        text_or_clear(row, input, "icon", "icon");
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"id": id})))
}

/// A list's area, by the id of the area container it sits in.
fn set_area(world: &World, row: &mut Row, area: Option<&str>) {
    row.extra.remove("area_id");
    row.fields.remove("area");
    if let Some((id, title)) = area.and_then(|area| world.areas.iter().find(|(id, _)| id == area)) {
        row.extra.insert("area_id", id.clone());
        put(row, "area", nonempty(title));
    }
}

fn container_move(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    let predicate = "container_can_go_there";
    let Some(key) = key_of(world, &id).filter(|key| is_container(key.0)) else {
        return Ok(refused(predicate, &gone(world, &id)));
    };
    let parent = text(input, "parent").map(str::to_owned);
    if key.0 == Kind::List {
        if let Some(parent) = &parent
            && !world.areas.iter().any(|(area, _)| area == parent)
        {
            return Ok(refused(predicate, "a project goes inside an area"));
        }
        let mut row = world.rows.remove(&key).ok_or("the row was just found")?;
        set_area(world, &mut row, parent.as_deref());
        row.updated = cx.now.clone();
        world.rows.insert(key, row);
    } else if key.0 == Kind::Section {
        let list_title = parent
            .as_ref()
            .and_then(|p| world.rows.get(&(Kind::List, p.clone())))
            .map(|r| r.name.clone());
        if let Some(row) = world.rows.get_mut(&key) {
            match parent {
                Some(parent) => {
                    row.extra.insert("list_id", parent);
                    put(row, "list", list_title.as_deref().and_then(nonempty));
                }
                None => {
                    row.extra.remove("list_id");
                    row.fields.remove("list");
                }
            }
            if let Some(pos) = input.get("position").and_then(Value::as_f64) {
                row.fields.insert("position", Val::Num(pos.round() as i64));
            }
            row.updated = cx.now.clone();
        }
    } else if let Some(row) = world.rows.get_mut(&key) {
        match parent {
            Some(parent) => {
                row.extra.insert("parent", parent);
            }
            None => {
                row.extra.remove("parent");
            }
        }
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"id": id})))
}

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

    /// A write that must succeed (a follow-up of a create).
    pub(crate) fn write_must(&mut self, call: &Call, input: Value) -> Result<Value, String> {
        let ran = self.write_step(call, &input)?;
        if ran.ok {
            Ok(ran.output)
        } else {
            Err(format!(
                "{} refused {input}: {}",
                call.command,
                ran.reason.unwrap_or_default()
            ))
        }
    }

    fn patch(&mut self, command: &str, input: &Value, real: Option<&Value>) -> Result<Ran, String> {
        let now = centraid_vault::clock::format_iso_ms(self.door.now_ms());
        let door = &*self.door;
        let mint = || door.mint_id();
        let cx = Cx {
            now,
            mint: &mint,
            real,
        };
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

/// Whether two rows match on every model-visible field except their id (used to match
/// vault-minted `LockerField` template rows in `Writes::Shadow` where `real.output` carries only
/// the item id and field count).
fn same_row_body(a: &Row, b: &Row) -> bool {
    a.kind == b.kind
        && a.name == b.name
        && a.date == b.date
        && a.fields == b.fields
        && a.trashed == b.trashed
        && a.created == b.created
        && a.extra == b.extra
}

/// Where two worlds part, field by field: what a patch got wrong. `updated` is left out (a
/// trigger stamps it from the host clock).
pub(crate) fn drift(patched: &World, real: &World) -> Vec<String> {
    let mut out = Vec::new();
    let mut unmatched_real_fields: Vec<(&Key, &Row)> = real
        .rows
        .iter()
        .filter(|(k, _)| k.0 == Kind::LockerField && !patched.rows.contains_key(*k))
        .collect();
    let mut paired_patched_fields: std::collections::BTreeSet<&Key> =
        std::collections::BTreeSet::new();
    let mut paired_real_fields: std::collections::BTreeSet<&Key> =
        std::collections::BTreeSet::new();
    for (pk, prow) in patched
        .rows
        .iter()
        .filter(|(k, _)| k.0 == Kind::LockerField && !real.rows.contains_key(*k))
    {
        if let Some(pos) = unmatched_real_fields
            .iter()
            .position(|(_, r)| same_row_body(prow, r))
        {
            paired_patched_fields.insert(pk);
            paired_real_fields.insert(unmatched_real_fields.swap_remove(pos).0);
        }
    }
    let keys: std::collections::BTreeSet<&Key> =
        patched.rows.keys().chain(real.rows.keys()).collect();
    for key in keys {
        let name = |row: &Row| format!("{} {} ({})", key.0.name(), row.name, key.1);
        match (patched.rows.get(key), real.rows.get(key)) {
            (Some(row), None) => {
                if !paired_patched_fields.contains(key) {
                    out.push(format!("{}: only the patch has it", name(row)));
                }
            }
            (None, Some(row)) => {
                if !paired_real_fields.contains(key) {
                    out.push(format!("{}: only the vault has it", name(row)));
                }
            }
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

/// The columns each Locker type owns; every other is nulled on a write.
fn locker_type_fields(item_type: &str) -> &'static [&'static str] {
    centraid_vault::commands::locker::type_fields(item_type)
}

/// The columns a Locker row holds, as the loader read them.
fn locker_columns(row: &Row) -> BTreeMap<&'static str, String> {
    let mut columns = BTreeMap::new();
    for column in ["username", "url", "notes"] {
        if let Some(Val::Text(value)) = row.field(column)
            && !(column == "notes" && value == crate::native::world::SEALED)
        {
            columns.insert(column, value.clone());
        }
    }
    for (name, value) in &row.extra {
        if !matches!(*name, "key_id" | "purge_at" | "archived") {
            columns.insert(name, value.clone());
        }
    }
    columns
}

/// Write the columns back as the loader reads them.
fn locker_store(row: &mut Row, item_type: &str, columns: &BTreeMap<&'static str, String>) {
    row.fields
        .insert("type", Val::Enum(locker_model_type(item_type)));
    for field in ["username", "url", "notes"] {
        put(
            row,
            field,
            columns.get(field).and_then(|value| nonempty(value)),
        );
    }
    if item_type == "note"
        && columns
            .get("content")
            .is_some_and(|value| !value.is_empty())
    {
        row.fields
            .insert("notes", Val::Text(crate::native::world::SEALED.to_owned()));
    }
    row.extra
        .retain(|name, _| matches!(*name, "key_id" | "purge_at" | "archived"));
    for (name, value) in columns {
        let sealed = crate::native::meta::REVEAL_FIELDS
            .iter()
            .any(|(_, column)| column == name);
        let plain = crate::native::world::is_locker_plain(name);
        if (sealed || plain) && !value.is_empty() {
            // A sealed cell is a presence bit in the world, as `World::load` reads it: what the
            // member typed is held by the parked step and nowhere else.
            let held = if sealed {
                centraid_vault::commands::locker::SEALED_PLACEHOLDER.to_owned()
            } else {
                value.clone()
            };
            row.extra.insert(name, held);
        }
    }
}

fn locker_model_type(item_type: &str) -> &'static str {
    Kind::LockerItem
        .spec()
        .field("type")
        .and_then(|field| field.model_value(item_type))
        .unwrap_or("login")
}

fn locker_template_fields(item_type: &str) -> &'static [(&'static str, &'static str, &'static str)] {
    match item_type {
        "ssh_key" => &[
            ("Key", "Private key", "sealed"),
            ("Key", "Key passphrase", "sealed"),
            ("Key", "Public key", "text"),
            ("Key", "Fingerprint", "text"),
            ("Host", "Host", "text"),
            ("Host", "User", "text"),
        ],
        "api_credential" => &[
            ("Credential", "Key id", "text"),
            ("Credential", "Secret", "sealed"),
            ("Service", "Endpoint", "url"),
            ("Service", "Environment", "text"),
            ("Service", "Expires", "date"),
        ],
        "passport" => &[
            ("Document", "Passport number", "sealed"),
            ("Holder", "Full name", "text"),
            ("Holder", "Nationality", "text"),
            ("Holder", "Date of birth", "date"),
            ("Document", "Issued", "date"),
            ("Document", "Expires", "date"),
            ("Document", "Place of issue", "text"),
        ],
        "bank_account" => &[
            ("Account", "Account holder", "text"),
            ("Account", "Account number", "sealed"),
            ("Account", "Sort code or routing number", "sealed"),
            ("Account", "IBAN", "sealed"),
            ("Bank", "BIC or SWIFT", "text"),
            ("Bank", "Bank", "text"),
        ],
        "driving_licence" => &[
            ("Licence", "Licence number", "sealed"),
            ("Holder", "Full name", "text"),
            ("Holder", "Date of birth", "date"),
            ("Licence", "Issued", "date"),
            ("Licence", "Expires", "date"),
            ("Licence", "Issuing authority", "text"),
            ("Licence", "Classes", "text"),
        ],
        "software_licence" => &[
            ("Licence", "Licence key", "sealed"),
            ("Product", "Product", "text"),
            ("Product", "Version", "text"),
            ("Licence", "Registered to", "text"),
            ("Purchase", "Purchased", "date"),
            ("Licence", "Expires", "date"),
            ("Purchase", "Order reference", "text"),
        ],
        "crypto_wallet" => &[
            ("Recovery", "Recovery phrase", "sealed"),
            ("Keys", "Private key", "sealed"),
            ("Keys", "Wallet passphrase", "sealed"),
            ("Wallet", "Public address", "text"),
            ("Wallet", "Network", "text"),
            ("Wallet", "Wallet software", "text"),
        ],
        "membership" => &[
            ("Membership", "Member number", "text"),
            ("Membership", "Organisation", "text"),
            ("Membership", "Tier", "text"),
            ("Membership", "Member since", "date"),
            ("Membership", "Expires", "date"),
            ("Access", "PIN", "sealed"),
            ("Access", "Website", "url"),
        ],
        "document" => &[
            ("Document", "Reference", "text"),
            ("Document", "Issued by", "text"),
            ("Document", "Issued", "date"),
            ("Document", "Expires", "date"),
        ],
        _ => &[],
    }
}

fn locker_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "item_id").unwrap_or_default().to_owned();
    if world.rows.contains_key(&(Kind::LockerItem, id.clone())) {
        return Ok(refused("item_id_free", "that item id is taken"));
    }
    let item_type = text(input, "type").unwrap_or("login");
    let mut row = new_row(
        Kind::LockerItem,
        &id,
        text(input, "title").unwrap_or_default(),
        cx,
    );
    row.fields.insert("starred", Val::Bool(false));
    let mut columns = BTreeMap::new();
    for column in locker_type_fields(item_type) {
        if let Some(value) = text(input, column).filter(|value| !value.is_empty()) {
            columns.insert(*column, value.to_owned());
        }
    }
    locker_store(&mut row, item_type, &columns);
    if let Some(key) = text(input, "key_id") {
        row.extra.insert("key_id", key.to_owned());
    }
    world.rows.insert(row.key(), row);
    let templates = locker_template_fields(item_type);
    for (index, (section, label, field_kind)) in templates.iter().enumerate() {
        let field_id = (cx.mint)();
        let mut field_row = new_row(Kind::LockerField, &field_id, label, cx);
        let mut fields = BTreeMap::new();
        fields.insert("item_id", Val::Text(id.clone()));
        if !section.is_empty() {
            fields.insert("section", Val::Text((*section).to_owned()));
        }
        fields.insert("label", Val::Text((*label).to_owned()));
        fields.insert("field_kind", Val::Text((*field_kind).to_owned()));
        fields.insert("position", Val::Num(i64::try_from(index).unwrap_or(0)));
        field_row.fields = fields;
        field_row.extra.insert("item_id", id.clone());
        world.rows.insert(field_row.key(), field_row);
    }
    Ok(ok(json!({"item_id": id, "template_fields": templates.len()})))
}

fn locker_duplicate(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let source_id = text(input, "item_id").unwrap_or_default();
    let Some(source) = live(world, Kind::LockerItem, source_id).cloned() else {
        return Ok(refused("item_live", "that item is not in your locker"));
    };
    let new_id = text(input, "new_item_id")
        .map(str::to_owned)
        .unwrap_or_else(|| cx.id("item_id"));
    let title = format!("{} copy", source.name);
    let item_type = match source.field("type") {
        Some(Val::Enum(model)) => (*model).to_owned(),
        _ => "login".to_owned(),
    };
    let mut row = new_row(Kind::LockerItem, &new_id, &title, cx);
    row.fields.insert("starred", Val::Bool(false));
    let mut columns = BTreeMap::new();
    for (name, value) in locker_columns(&source) {
        let sealed = crate::native::meta::REVEAL_FIELDS
            .iter()
            .any(|(_, col)| *col == name);
        if !sealed {
            columns.insert(name, value);
        }
    }
    for column in centraid_vault::commands::locker::SEALED_ITEM_CELLS {
        if let Some(value) = text(input, column)
            .filter(|v| !v.is_empty() && *v != centraid_vault::commands::locker::SEALED_PLACEHOLDER)
        {
            columns.insert(column, value.to_owned());
        }
    }
    locker_store(&mut row, &item_type, &columns);
    if let Some(key) = text(input, "key_id") {
        row.extra.insert("key_id", key.to_owned());
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"item_id": new_id, "title": title, "fields": 0})))
}

fn locker_set_field(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let item_id = text(input, "item_id").unwrap_or_default().to_owned();
    let Some(item_row) = live(world, Kind::LockerItem, &item_id).cloned() else {
        return Ok(refused("item_live", "that item is not in your locker"));
    };
    let field_id = text(input, "field_id")
        .map(str::to_owned)
        .unwrap_or_else(|| cx.id("field_id"));
    let label = text(input, "label").unwrap_or_default().to_owned();
    let field_kind = text(input, "kind").unwrap_or("text").to_owned();
    let mut row = new_row(Kind::LockerField, &field_id, &label, cx);
    row.created = item_row.created;
    row.fields.insert("item_id", Val::Text(item_id.clone()));
    if let Some(section) = text(input, "section").filter(|s| !s.is_empty()) {
        row.fields.insert("section", Val::Text(section.to_owned()));
    }
    row.fields.insert("label", Val::Text(label));
    row.fields.insert("field_kind", Val::Text(field_kind.clone()));
    if matches!(field_kind.as_str(), "sealed" | "otp") {
        row.fields
            .insert("value", Val::Text(crate::native::world::SEALED.to_owned()));
    } else if let Some(val) = text(input, "value").filter(|s| !s.is_empty()) {
        row.fields.insert("value", Val::Text(val.to_owned()));
    }
    let pos = int(input, "position").unwrap_or(0);
    row.fields.insert("position", Val::Num(pos));
    row.extra.insert("item_id", item_id.clone());
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"field_id": field_id, "item_id": item_id})))
}

fn locker_remove_field(world: &mut World, input: &Value) -> Result<Ran, String> {
    let item_id = text(input, "item_id").unwrap_or_default();
    let field_id = text(input, "field_id").unwrap_or_default();
    if live(world, Kind::LockerItem, item_id).is_none() {
        return Ok(refused("item_live", "that item is not in your locker"));
    }
    let key = (Kind::LockerField, field_id.to_owned());
    if world
        .rows
        .get(&key)
        .is_none_or(|r| r.extra.get("item_id").map(String::as_str) != Some(item_id))
    {
        return Ok(refused(
            "field_exists",
            "there is no custom field with that id",
        ));
    }
    world.rows.remove(&key);
    Ok(ok(json!({"field_id": field_id, "item_id": item_id})))
}

fn locker_set_addresses(world: &mut World, input: &Value) -> Result<Ran, String> {
    let item_id = text(input, "item_id").unwrap_or_default();
    if live(world, Kind::LockerItem, item_id).is_none() {
        return Ok(refused("item_live", "that item is not in your locker"));
    }
    let count = input
        .get("addresses")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    Ok(ok(json!({"item_id": item_id, "count": count})))
}

fn locker_set_passkey(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let item_id = text(input, "item_id").unwrap_or_default().to_owned();
    if live(world, Kind::LockerItem, &item_id).is_none() {
        return Ok(refused("item_live", "that item is not in your locker"));
    }
    let rp_id = text(input, "rp_id").unwrap_or_default().to_owned();
    let mut row = new_row(Kind::LockerPasskey, &item_id, &rp_id, cx);
    row.fields.insert("rp_id", Val::Text(rp_id));
    if let Some(handle) = text(input, "user_handle").filter(|s| !s.is_empty()) {
        row.fields
            .insert("user_handle", Val::Text(handle.to_owned()));
    }
    if let Some(dn) = text(input, "display_name").filter(|s| !s.is_empty()) {
        row.fields.insert("display_name", Val::Text(dn.to_owned()));
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"item_id": item_id})))
}

fn locker_clear_passkey(world: &mut World, input: &Value) -> Result<Ran, String> {
    let item_id = text(input, "item_id").unwrap_or_default();
    if live(world, Kind::LockerItem, item_id).is_none() {
        return Ok(refused("item_live", "that item is not in your locker"));
    }
    world.rows.remove(&(Kind::LockerPasskey, item_id.to_owned()));
    Ok(ok(json!({"item_id": item_id})))
}

fn locker_set_memo(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let item_id = text(input, "item_id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::LockerItem, item_id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("item_live", "that item is not in your locker"));
    };
    let note = text(input, "note").unwrap_or_default();
    put(row, "notes", nonempty(note));
    row.updated = cx.now.clone();
    Ok(ok(json!({"item_id": item_id})))
}

/// A new account: its type, its currency (the vault's when it names none) and a zero opening.
/// The figures of a workout as the world shows them (whole numbers), by the columns that hold them.
const WORKOUT_FIGURES: [(&str, &str); 5] = [
    ("moving", "moving_s"),
    ("distance", "distance_m"),
    ("energy", "energy_kcal"),
    ("heart_rate", "heart_bpm"),
    ("climb", "climb_m"),
];

/// Set the figures `input` states on a workout row: a number, or `null` to clear one.
fn workout_figures(row: &mut Row, input: &Value) {
    for (field, column) in WORKOUT_FIGURES {
        match input.get(column) {
            Some(Value::Number(number)) => {
                let figure = number.as_f64().unwrap_or_default().round() as i64;
                row.fields.insert(field, Val::Num(figure));
            }
            Some(Value::Null) => {
                row.fields.remove(field);
            }
            _ => {}
        }
    }
}

/// A workout the member logs: an activity and its figures, with no store behind it.
fn workout_log(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let title = text(input, "title")
        .or_else(|| text(input, "type"))
        .unwrap_or("workout")
        .trim()
        .to_owned();
    let mut row = new_row(Kind::Workout, &id, &title, cx);
    row.date = text(input, "starts").and_then(|starts| local_stamp(&world.zone, starts));
    if let Some(end_stamp) = text(input, "ends").and_then(|ends| local_stamp(&world.zone, ends)) {
        if let Some(starts) = row.date
            && end_stamp < starts
        {
            return Ok(refused(
                "a_workout_starts_on_a_day_and_does_not_end_before",
                "A workout cannot end before it starts.",
            ));
        }
        row.fields.insert("ends", Val::Date(end_stamp));
    }
    workout_figures(&mut row, input);
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id, "workout_id": id})))
}

fn workout_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let zone = world.zone.clone();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Workout, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused(
            "a_workout_the_member_logged",
            "There is no such workout.",
        ));
    };
    if let Some(store) = row.extra.get("followed_by") {
        return Ok(refused(
            "a_workout_the_member_logged",
            &format!("This workout comes from {store}; change it there, not here."),
        ));
    }
    if let Some(title) = text(input, "title") {
        row.name = title.trim().to_owned();
    }
    if let Some(starts) = text(input, "starts") {
        row.date = local_stamp(&zone, starts);
    }
    if input.get("ends").is_some_and(Value::is_null) {
        row.fields.remove("ends");
    } else if let Some(end_stamp) = text(input, "ends").and_then(|ends| local_stamp(&zone, ends))
    {
        if row.date.is_some_and(|starts| end_stamp < starts) {
            return Ok(refused(
                "a_workout_the_member_logged_and_does_not_end_before",
                "A workout cannot end before it starts.",
            ));
        }
        row.fields.insert("ends", Val::Date(end_stamp));
    } else if let (Some(starts), Some(Val::Date(end_stamp))) = (row.date, row.field("ends"))
        && *end_stamp < starts
    {
        return Ok(refused(
            "a_workout_the_member_logged_and_does_not_end_before",
            "A workout cannot end before it starts.",
        ));
    }
    workout_figures(row, input);
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id, "workout_id": id})))
}

/// A daily figure the member states by hand: the value of one metric on one day.
fn measurement_log(world: &mut World, _: &Cx, input: &Value) -> Result<Ran, String> {
    let (day, metric) = match (text(input, "day"), text(input, "metric")) {
        (Some(day), Some(metric)) => (day.to_owned(), metric.to_owned()),
        _ => match text(input, "id").and_then(|id| id.split_once(':')) {
            Some((day, metric)) => (day.to_owned(), metric.to_owned()),
            None => {
                return Ok(refused(
                    "a_figure_names_a_day_and_a_metric",
                    "Name the day and the metric.",
                ));
            }
        },
    };
    if let Some(store) = &world.health_store {
        return Ok(refused(
            "a_figure_no_store_states",
            &format!("These figures come from {store}; change them there, not here."),
        ));
    }
    let value = input
        .get("value")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    let key = (Kind::DailyFigure, format!("{day}:{metric}"));
    match world.rows.get_mut(&key) {
        Some(row) => {
            row.fields.insert("value", Val::Num(value.round() as i64));
        }
        None => {
            let mut fields = BTreeMap::new();
            if let Some(model) = Kind::DailyFigure
                .spec()
                .field("metric")
                .and_then(|field| field.model_value(&metric))
            {
                fields.insert("metric", Val::Enum(model));
            }
            fields.insert("value", Val::Num(value.round() as i64));
            world.rows.insert(
                key.clone(),
                Row {
                    kind: Kind::DailyFigure,
                    id: key.1.clone(),
                    name: metric,
                    date: Stamp::parse(&day),
                    fields,
                    trashed: false,
                    created: String::new(),
                    updated: String::new(),
                    extra: BTreeMap::new(),
                },
            );
        }
    }
    Ok(ok(json!({"id": key.1, "day": day})))
}

/// A figure the member logged, taken back.
fn measurement_clear(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = match (text(input, "day"), text(input, "metric")) {
        (Some(day), Some(metric)) => format!("{day}:{metric}"),
        _ => text(input, "id").unwrap_or_default().to_owned(),
    };
    if let Some(store) = &world.health_store {
        return Ok(refused(
            "a_figure_the_member_logged_and_no_store_states",
            &format!("These figures come from {store}; change them there, not here."),
        ));
    }
    match world.rows.remove(&(Kind::DailyFigure, id.clone())) {
        Some(_) => Ok(ok(json!({"id": id}))),
        None => Ok(refused(
            "a_figure_the_member_logged_and_no_store_states",
            &format!("There is no figure {id}."),
        )),
    }
}

fn account_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let title = text(input, "title")
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let opening_minor = int(input, "opening_minor").unwrap_or(0);
    let opening_on = text(input, "opening_on")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if opening_minor != 0 && opening_on.is_none() {
        return Ok(refused(
            "opening_sentence",
            "An opening balance needs the day it was true.",
        ));
    }
    let mut row = new_row(Kind::Account, &id, &title, cx);
    if let Some(model) = Kind::Account
        .spec()
        .field("type")
        .and_then(|field| field.model_value(text(input, "type").unwrap_or_default()))
    {
        row.fields.insert("type", Val::Enum(model));
    }
    let currency =
        text(input, "currency").map_or_else(|| world.currency.clone(), str::to_uppercase);
    row.fields.insert("currency", Val::Text(currency.clone()));
    row.fields
        .insert("opening", Val::Money(opening_minor, currency));
    if let Some(day) = opening_on {
        row.fields.insert("opening_on", Val::Text(day.clone()));
        row.extra.insert("opening_on", day);
    }
    row.fields.insert(
        "on_budget",
        Val::Bool(
            input
                .get("on_budget")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        ),
    );
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id})))
}

/// A category the member makes: its id and key are its folded name, under its group's.
fn category_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let title = text(input, "title")
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let parent = text(input, "parent_id");
    let group_key = parent.map(|parent| parent.trim_start_matches("category:").to_owned());
    let folded = centraid_vault::model::fold_label(&title);
    let key = match &group_key {
        Some(group) => format!("{group}.{folded}"),
        None => folded,
    };
    let id = format!("category:{key}");
    if world.rows.contains_key(&(Kind::Category, id.clone())) {
        return Ok(refused("category_is_new", "that category already exists"));
    }
    let mut row = new_row(Kind::Category, &id, &title, cx);
    put(&mut row, "key", nonempty(&key));
    put(
        &mut row,
        "group",
        parent
            .and_then(|parent| world.rows.get(&(Kind::Category, parent.to_owned())))
            .map(|group| Val::Text(group.name.clone())),
    );
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id})))
}

/// An account's rename, type and budget membership: the fields the world reads.
fn account_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Account, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("account_live", &gone_text(id)));
    };
    let old_name = row.name.clone();
    if let Some(title) = text(input, "title") {
        row.name = title.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    let new_name = row.name.clone();
    if let Some(vault) = text(input, "type")
        && let Some(model) = Kind::Account
            .spec()
            .field("type")
            .and_then(|field| field.model_value(vault))
    {
        row.fields.insert("type", Val::Enum(model));
    }
    if let Some(on) = input.get("on_budget").and_then(Value::as_bool) {
        row.fields.insert("on_budget", Val::Bool(on));
    }
    row.updated = cx.now.clone();
    // a transaction names its account: a rename reads through every line of it
    if old_name != new_name {
        for line in world
            .rows
            .values_mut()
            .filter(|r| r.kind == Kind::Transaction)
        {
            if line.fields.get("account") == Some(&Val::Text(old_name.clone())) {
                line.fields.insert("account", Val::Text(new_name.clone()));
            }
        }
    }
    Ok(ok(json!({"id": id})))
}

fn stock_category_title(id: &str) -> Option<&'static str> {
    match id {
        "category:income" => Some("Income"),
        "category:housing" => Some("Housing"),
        "category:utilities" => Some("Utilities"),
        "category:food" => Some("Food"),
        "category:transport" => Some("Transport"),
        "category:shopping" => Some("Shopping"),
        "category:health" => Some("Health"),
        "category:fun" => Some("Fun and travel"),
        "category:fees" => Some("Fees and taxes"),
        "category:income.pay" => Some("Pay"),
        "category:income.other" => Some("Other income"),
        "category:housing.rent" => Some("Rent or mortgage"),
        "category:housing.home" => Some("Home and repairs"),
        "category:utilities.bills" => Some("Power, gas and water"),
        "category:utilities.phone" => Some("Phone and internet"),
        "category:food.groceries" => Some("Groceries"),
        "category:food.dining" => Some("Dining out"),
        "category:transport.fuel" => Some("Fuel"),
        "category:transport.transit" => Some("Transit and rideshare"),
        "category:shopping.general" => Some("Clothes and household"),
        "category:health.care" => Some("Health care"),
        "category:fun.subscriptions" => Some("Subscriptions"),
        "category:fun.entertainment" => Some("Entertainment and travel"),
        _ => None,
    }
}

fn category_title(world: &World, id: &str) -> Option<String> {
    world
        .rows
        .get(&(Kind::Category, id.to_owned()))
        .map(|row| row.name.clone())
        .or_else(|| stock_category_title(id).map(str::to_owned))
}

fn account_set_opening(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let world_currency = world.currency.clone();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Account, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("account_live", &gone_text(id)));
    };
    let opening_minor = int(input, "opening_minor").unwrap_or(0);
    let opening_on = text(input, "opening_on")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if opening_minor != 0 && opening_on.is_none() {
        return Ok(refused(
            "opening_sentence",
            "An opening balance needs the day it was true.",
        ));
    }
    let currency = match row.field("currency") {
        Some(Val::Text(c)) => c.clone(),
        _ => match row.field("opening") {
            Some(Val::Money(_, c)) => c.clone(),
            _ => world_currency,
        },
    };
    row.fields
        .insert("opening", Val::Money(opening_minor, currency));
    if let Some(day) = opening_on {
        row.fields.insert("opening_on", Val::Text(day.clone()));
        row.extra.insert("opening_on", day);
    } else {
        row.fields.remove("opening_on");
        row.extra.remove("opening_on");
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id, "changed": true})))
}

fn category_merge(world: &mut World, input: &Value) -> Result<Ran, String> {
    let from_id = text(input, "from_id").unwrap_or_default().to_owned();
    let into_id = text(input, "into_id").unwrap_or_default().to_owned();
    let Some(from_title) = category_title(world, &from_id) else {
        return Ok(refused("category_exists", &gone_text(&from_id)));
    };
    let Some(into_title) = category_title(world, &into_id) else {
        return Ok(refused("category_exists", &gone_text(&into_id)));
    };
    if from_id == into_id {
        return Ok(refused("categories_distinct", "choose two different categories"));
    }
    for row in world.rows.values_mut() {
        if matches!(row.kind, Kind::Transaction | Kind::Rule)
            && row.fields.get("category") == Some(&Val::Text(from_title.clone()))
        {
            row.fields
                .insert("category", Val::Text(into_title.clone()));
        }
    }
    world.rows.remove(&(Kind::Category, from_id.clone()));
    Ok(ok(json!({"from_id": from_id, "into_id": into_id})))
}

fn checkpoint_record(world: &mut World, input: &Value) -> Result<Ran, String> {
    let account_id = text(input, "account_id").unwrap_or_default();
    if live(world, Kind::Account, account_id).is_none() {
        return Ok(refused("account_live", &gone_text(account_id)));
    }
    Ok(ok(json!({
        "account_id": account_id,
        "day": text(input, "day").unwrap_or_default()
    })))
}

fn txn_categorize(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let category_id = text(input, "category_id").unwrap_or_default();
    let Some(cat_title) = category_title(world, category_id) else {
        return Ok(refused("category_exists", &gone_text(category_id)));
    };
    let ids: Vec<String> = input
        .get("ids")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut changed = 0_usize;
    for id in &ids {
        if let Some(row) = world
            .rows
            .get_mut(&(Kind::Transaction, id.clone()))
            .filter(|row| !row.trashed)
        {
            row.fields.insert("category", Val::Text(cat_title.clone()));
            row.updated = cx.now.clone();
            changed += 1;
        }
    }
    Ok(ok(json!({"changed": changed})))
}

fn budget_set(world: &mut World, input: &Value) -> Result<Ran, String> {
    let month = text(input, "month").unwrap_or_default().to_owned();
    let category_id = text(input, "category_id").unwrap_or_default().to_owned();
    let id = format!("{category_id}:{month}");
    let key = (Kind::Budget, id.clone());
    if input.get("amount_minor").is_some_and(Value::is_null) {
        let removed = world.rows.remove(&key).is_some();
        return Ok(ok(json!({"changed": removed})));
    }
    let amount_minor = int(input, "amount_minor").unwrap_or(0);
    let currency = text(input, "currency")
        .map(str::to_uppercase)
        .unwrap_or_else(|| world.currency.clone());
    let carry = input.get("carry").and_then(Value::as_bool);
    let cat_title = category_title(world, &category_id).unwrap_or_default();
    if let Some(row) = world.rows.get_mut(&key) {
        row.fields
            .insert("amount", Val::Money(amount_minor, currency.clone()));
        row.fields.insert("currency", Val::Text(currency));
        if let Some(carry) = carry {
            row.fields.insert("carry", Val::Bool(carry));
        }
    } else {
        let mut fields = BTreeMap::new();
        fields.insert("amount", Val::Money(amount_minor, currency.clone()));
        fields.insert("currency", Val::Text(currency));
        fields.insert("carry", Val::Bool(carry.unwrap_or(false)));
        world.rows.insert(
            key,
            Row {
                kind: Kind::Budget,
                name: format!("{cat_title} {month}"),
                id,
                date: None,
                fields,
                trashed: false,
                created: String::new(),
                updated: String::new(),
                extra: BTreeMap::new(),
            },
        );
    }
    Ok(ok(json!({"changed": true})))
}

fn budget_set_carry(world: &mut World, input: &Value) -> Result<Ran, String> {
    let month = text(input, "month").unwrap_or_default();
    let category_id = text(input, "category_id").unwrap_or_default();
    let carry = input.get("carry").and_then(Value::as_bool).unwrap_or(false);
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Budget, format!("{category_id}:{month}")))
    else {
        return Ok(refused("budget_exists", "Set an amount for that month first."));
    };
    row.fields.insert("carry", Val::Bool(carry));
    Ok(ok(json!({"changed": true})))
}

fn txn_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    if !world
        .rows
        .get(&(Kind::Transaction, id.clone()))
        .is_some_and(|row| !row.trashed)
    {
        return Ok(refused("transaction_exists", &gone_text(&id)));
    }
    if text(input, "status") == Some("void") {
        let _ = transfer(world, &json!({"id": id}), false);
    }
    let category_name = match input.get("category_id") {
        Some(Value::Null) => Some(None),
        Some(Value::String(cat)) => Some(category_title(world, cat)),
        _ => None,
    };
    let world_currency = world.currency.clone();
    let Some(row) = world.rows.get_mut(&(Kind::Transaction, id.clone())) else {
        return Ok(refused("transaction_exists", &gone_text(&id)));
    };
    if let Some(title) = text(input, "title") {
        row.name = title.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    if let Some(posted_on) = text(input, "posted_on") {
        row.date = Stamp::parse(posted_on);
    }
    if let Some(amount_minor) = int(input, "amount_minor") {
        let currency = match row.field("amount") {
            Some(Val::Money(_, c)) => c.clone(),
            _ => row
                .extra
                .get("currency")
                .cloned()
                .unwrap_or(world_currency),
        };
        row.fields
            .insert("amount", Val::Money(amount_minor, currency));
    }
    if let Some(cat) = category_name {
        match cat {
            Some(title) => {
                row.fields.insert("category", Val::Text(title));
            }
            None => {
                row.fields.remove("category");
            }
        }
    }
    if let Some(status) = text(input, "status") {
        let model_status = if status == "void" { "void" } else { "posted" };
        row.fields.insert("status", Val::Enum(model_status));
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id, "changed": true})))
}

/// A rule's text (upper-cased as the vault matches it), category and order.
fn rule_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let category_id = text(input, "category_id").unwrap_or_default();
    let Some(cat_title) = category_title(world, category_id) else {
        return Ok(refused("category_exists", &gone_text(category_id)));
    };
    let raw_text = text(input, "text").unwrap_or_default();
    let normalised = raw_text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();
    let display_name = text(input, "display_name")
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let row_name = if !normalised.is_empty() {
        normalised.clone()
    } else {
        display_name.unwrap_or_default().to_owned()
    };
    let position = input
        .get("position")
        .and_then(Value::as_f64)
        .map(|p| p.round() as i64)
        .unwrap_or(1);
    let mut row = new_row(Kind::Rule, &id, &row_name, cx);
    row.date = cx.stamp();
    row.fields.insert("category", Val::Text(cat_title));
    row.fields.insert("position", Val::Num(position));
    if let Some(dn) = display_name {
        row.fields
            .insert("display_name", Val::Text(dn.to_owned()));
    }
    if let Some(m) = text(input, "match").filter(|s| !s.is_empty()) {
        row.fields.insert("match", Val::Text(m.to_owned()));
    }
    if !normalised.is_empty() {
        row.fields.insert("text", Val::Text(normalised));
    }
    if let Some(min) = int(input, "min") {
        row.fields.insert("min", Val::Num(min));
    }
    if let Some(max) = int(input, "max") {
        row.fields.insert("max", Val::Num(max));
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id, "position": position})))
}

fn rule_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    let category = text(input, "category_id").and_then(|category| category_title(world, category));
    let Some(row) = world.rows.get_mut(&(Kind::Rule, id.clone())) else {
        return Ok(refused("rule_exists", &gone_text(&id)));
    };
    if let Some(matched) = text(input, "text") {
        let norm = matched
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_uppercase();
        row.name = norm.clone();
        put(row, "text", nonempty(&norm));
    }
    if let Some(m) = text(input, "match").filter(|s| !s.is_empty()) {
        row.fields.insert("match", Val::Text(m.to_owned()));
    }
    text_or_clear(row, input, "display_name", "display_name");
    if let Some(title) = category {
        row.fields.insert("category", Val::Text(title));
    }
    match input.get("min") {
        Some(Value::Null) => {
            row.fields.remove("min");
        }
        Some(value) => {
            if let Some(v) = value.as_i64() {
                row.fields.insert("min", Val::Num(v));
            }
        }
        None => {}
    }
    match input.get("max") {
        Some(Value::Null) => {
            row.fields.remove("max");
        }
        Some(value) => {
            if let Some(v) = value.as_i64() {
                row.fields.insert("max", Val::Num(v));
            }
        }
        None => {}
    }
    if let Some(position) = input
        .get("position")
        .and_then(Value::as_f64)
        .filter(|position| position.abs() < 1e9)
    {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "the filter keeps position finite and under a billion in magnitude"
        )]
        row.fields.insert("position", Val::Num(position as i64));
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn rule_delete(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    if world.rows.remove(&(Kind::Rule, id.to_owned())).is_none() {
        return Ok(refused("rule_exists", &gone_text(id)));
    }
    Ok(ok(json!({"deleted": 1})))
}

fn album_set_cover(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Album, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("album_live", &gone(world, id)));
    };
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn photo_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let title = text(input, "title").unwrap_or("photo");
    let mut row = new_row(Kind::Photo, &id, title, cx);
    row.date = text(input, "taken_at")
        .and_then(Stamp::parse)
        .or_else(|| cx.stamp());
    row.fields.insert("starred", Val::Bool(false));
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id, "deduped": false})))
}

fn photo_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Photo, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("photo_live", &gone(world, id)));
    };
    if let Some(taken) = text(input, "taken_at").and_then(Stamp::parse) {
        row.date = Some(taken);
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn photo_set_place(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Photo, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("photo_live", &gone(world, id)));
    };
    row.updated = cx.now.clone();
    Ok(ok(json!({"id": id})))
}

fn place_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "id").map_or_else(|| cx.id("id"), str::to_owned);
    let title = text(input, "title").unwrap_or_default().trim().to_owned();
    if title.is_empty() {
        return Ok(refused("place_has_a_name", "a place needs a name"));
    }
    let mut row = new_row(Kind::Place, &id, &title, cx);
    if let Some(address) = text(input, "address").filter(|s| !s.trim().is_empty()) {
        row.fields
            .insert("address", Val::Text(address.trim().to_owned()));
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"id": id})))
}

/// Two lines pointing at each other (or at nothing): the `transfer` field of both halves.
fn transfer(world: &mut World, input: &Value, link: bool) -> Result<Ran, String> {
    let id = text(input, "id").unwrap_or_default().to_owned();
    let Some(this) = world.rows.get(&(Kind::Transaction, id.clone())) else {
        return Ok(refused("transaction_exists", &gone_text(&id)));
    };
    let other = if link {
        text(input, "other_id").unwrap_or_default().to_owned()
    } else {
        match this.field("transfer") {
            Some(Val::Text(partner)) => partner.clone(),
            _ => String::new(),
        }
    };
    for (from, to) in [(&id, &other), (&other, &id)] {
        if let Some(row) = world.rows.get_mut(&(Kind::Transaction, from.clone())) {
            put(row, "transfer", link.then(|| Val::Text(to.clone())));
        }
    }
    Ok(ok(json!({"changed": true})))
}

fn gone_text(id: &str) -> String {
    format!("there is nothing with the id `{id}`")
}

fn locker_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "item_id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::LockerItem, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("item_live", "that item is not in your locker"));
    };
    let item_type = match row.field("type") {
        Some(Val::Enum(model)) => (*model).to_owned(),
        _ => "login".to_owned(),
    };
    if let Some(title) = text(input, "title") {
        row.name = title.to_owned();
    }
    let mut columns = locker_columns(row);
    let sealed = centraid_vault::commands::locker::SEALED_ITEM_CELLS;
    let carries = sealed.iter().any(|column| {
        text(input, column).is_some_and(|value| {
            !value.is_empty() && value != centraid_vault::commands::locker::SEALED_PLACEHOLDER
        })
    });
    // an edit rewrites the type's columns and nulls the ones it leaves out; a round-tripped
    // placeholder leaves its secret alone
    for column in locker_type_fields(&item_type) {
        match text(input, column) {
            Some(value) if value == centraid_vault::commands::locker::SEALED_PLACEHOLDER => {}
            Some(value) if !value.is_empty() => {
                columns.insert(*column, value.to_owned());
            }
            _ => {
                columns.remove(column);
            }
        }
    }
    let key = row.extra.get("key_id").cloned();
    locker_store(row, &item_type, &columns);
    let key = if carries {
        text(input, "key_id").map(str::to_owned)
    } else {
        key
    };
    if let Some(key) = key {
        row.extra.insert("key_id", key);
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"item_id": id, "rotated": false, "columns": []})))
}

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
