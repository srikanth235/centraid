//! PARK: a write that is planned, and shown to the model, but not made (#1088, R-1088-2, R-1088-6).
//!
//! On the phone every write waits for the member's tap. The runtime still plans it as it always
//! has and shows the model what it was trained to see after a write: the change lines of the
//! row, the `created:` echo, the diff. It does that against a PATCHED COPY OF THE WORLD instead
//! of the vault: [`apply`] takes the command a step would have run and does to the in-memory
//! [`World`] what the vault's command does to its tables, as far as the model's rows can tell.
//! Every later call of the turn then reads the patched world, so a `more=true` chain that names a
//! row the first write created works, and the observation text is the one a run would have shown.
//!
//! The steps themselves are kept, in order, as [`ParkedStep`]s: they are what a confirm runs.
//!
//! # What a patch owes the vault
//!
//! * The refusals the runtime acts on (`Session::refusal`, `compose_busy_conflict`): the id of
//!   the check that fails and its sentence are the vault's own, and a refusal changes nothing.
//! * The shape of every row a command touches, field for field, as `World::load` would read it
//!   back (`tests/park.rs` holds each patch to a real vault in [`Writes::Shadow`]).
//! * Ids: a row the runtime names before its command ([`Door::mint_id`]) keeps that id; an id the
//!   vault makes inside a command (a debt, a revision) is minted here and replaced by the real
//!   one when the step runs for real (`PendingWrite::aliases`).
//!
//! What a patch cannot know is what only the vault's tables hold and the world does not read: the
//! next occurrence a repeating task makes when it is completed, a trigger's host-time stamp
//! (`updated` is therefore not compared). Those are listed in the receipt, not guessed.

use std::collections::BTreeMap;

use centraid_apps_tally::queries::{GroupRow, SettlementRow};
use serde_json::{Value, json};

use crate::native::dates::Stamp;
use crate::native::door::Ran;
use crate::native::meta::{Kind, Via};
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
    /// compared and a difference is kept (`Session::drift`). The check that holds [`apply`] to
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
    pub command: String,
    pub input: Value,
    /// The patched world's answer: the ids it minted (`debt_id`, `revision_id`) are placeholders
    /// the real run replaces.
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
    }
}

fn refused(predicate: &str, reason: &str) -> Ran {
    Ran {
        ok: false,
        output: Value::Null,
        reason: Some(reason.to_owned()),
        predicate: Some(predicate.to_owned()),
    }
}

fn text<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    input.get(key).and_then(Value::as_str)
}

fn flag(input: &Value, key: &str) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(false)
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

/// Whether the window of a trashed row is still open: `purge_at IS NULL OR purge_at > now`.
fn window_open(row: &Row, now: &str) -> bool {
    row.extra
        .get("purge_at")
        .is_none_or(|purge| purge.as_str() > now)
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
        world.edges.push(Edge {
            from,
            to,
            via,
            link_id: None,
        });
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
    let start = Stamp::parse(start);
    let end = end.and_then(Stamp::parse);
    row.fields.remove("duration");
    row.date = start;
    if let (Some(start), Some(end)) = (start, end) {
        let minutes = end.at().duration_since(start.at()).as_secs() / 60;
        let all_day = start.time == Some(jiff::civil::Time::midnight())
            && minutes > 0
            && minutes % (24 * 60) == 0;
        if all_day {
            row.date = Some(Stamp {
                date: start.date,
                time: None,
            });
        } else {
            row.fields.insert("duration", Val::Num(minutes));
        }
    }
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
    // every command the vault answered leaves a journal row, a refusal too: the id seed of a
    // session numbers from the count
    let ran = patch(world, bin, cx, command, input)?;
    world.entity_count += 1;
    Ok(ran)
}

fn patch(
    world: &mut World,
    bin: &mut BTreeMap<String, (Row, Vec<Edge>)>,
    cx: &Cx,
    command: &str,
    input: &Value,
) -> Result<Ran, String> {
    match command {
        "people.add_person" => people_add(world, cx, input),
        "people.edit_person" | "people.set_cadence" => people_edit(world, cx, input),
        "people.trash_person" => trash_row(
            world,
            cx,
            input,
            Kind::Person,
            "party_id",
            "person_live",
            "That person is not here.",
        ),
        "people.restore_person" => restore_row(
            world,
            cx,
            input,
            Kind::Person,
            "party_id",
            "person_trashed",
            "that person is not in the trash, or their restore window has passed",
        ),
        "people.star_person" | "people.unstar_person" => star(
            world,
            input,
            Kind::Person,
            "party_id",
            command.contains(".star"),
        ),
        "people.log_interaction" => {
            let id = text(input, "party_id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Person, id.to_owned())) {
                Some(row) if !row.trashed => {
                    row.date = cx.stamp();
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"interaction_id": cx.id("interaction_id")})))
                }
                _ => Ok(refused("person_live", "That person is not here.")),
            }
        }
        "people.add_debt" => debt_add(world, cx, input),
        "people.settle_debt" => {
            let id = text(input, "debt_id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Debt, id.to_owned())) {
                Some(row) if row.field("status") == Some(&Val::Enum("open")) => {
                    row.fields.insert("status", Val::Enum("settled"));
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"debt_id": id})))
                }
                _ => Ok(refused("debt_open", "that debt is not open")),
            }
        }
        "schedule.save_project" => project_save(world, cx, input),
        "schedule.add_task" => task_add(world, cx, input),
        "schedule.edit_task" => task_edit(world, cx, input),
        "schedule.set_task_status" => task_status(world, cx, input),
        "schedule.delete_task" => task_delete(world, cx, input),
        "schedule.restore_task" => task_restore(world, cx, input),
        "schedule.organize_task" => task_organize(world, input),
        "schedule.propose_event" => event_propose(world, cx, input),
        "schedule.edit_event" => event_edit(world, cx, input),
        "schedule.reschedule_event" => event_reschedule(world, cx, input),
        "schedule.cancel_event" => {
            let id = text(input, "event_id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Event, id.to_owned())) {
                Some(row)
                    if !row.trashed && row.field("status") != Some(&Val::Enum("cancelled")) =>
                {
                    row.fields.insert("status", Val::Enum("cancelled"));
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"event_id": id, "sequence": 1})))
                }
                _ => Ok(refused(
                    "event_exists_not_cancelled",
                    "That event is not here to change.",
                )),
            }
        }
        "schedule.delete_event" => trash_row(
            world,
            cx,
            input,
            Kind::Event,
            "event_id",
            "event_live",
            "That event is not here to delete.",
        ),
        "schedule.restore_event" => restore_row(
            world,
            cx,
            input,
            Kind::Event,
            "event_id",
            "event_trashed",
            "That event is not in the trash any more.",
        ),
        "knowledge.create_note" => note_create(world, cx, input),
        "knowledge.edit_note" => note_edit(world, cx, input),
        "knowledge.delete_note" => trash_row(
            world,
            cx,
            input,
            Kind::Note,
            "note_id",
            "note_is_live",
            "That note is not here.",
        ),
        "knowledge.restore_note" => restore_row(
            world,
            cx,
            input,
            Kind::Note,
            "note_id",
            "note_in_trash",
            "That note is not in the trash, or its window has lapsed.",
        ),
        "knowledge.move_note" => note_move(world, input),
        "knowledge.create_notebook" => notebook_create(world, cx, input),
        "knowledge.rename_notebook" => notebook_rename(world, input),
        "knowledge.delete_notebook" => notebook_delete(world, input),
        "core.add_document" => document_add(world, cx, input),
        "core.rename_document" => {
            let id = text(input, "document_id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Document, id.to_owned())) {
                Some(row) if !row.trashed => {
                    row.name = text(input, "title").unwrap_or_default().to_owned();
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"document_id": id})))
                }
                _ => Ok(refused("document_live", "That document is not here.")),
            }
        }
        "core.trash_document" => trash_row(
            world,
            cx,
            input,
            Kind::Document,
            "document_id",
            "document_live",
            "That document is not here.",
        ),
        "core.restore_document" => restore_row(
            world,
            cx,
            input,
            Kind::Document,
            "document_id",
            "document_in_trash",
            "that document is not in the trash, or its grace window has run out",
        ),
        "core.star_document" | "core.unstar_document" => star(
            world,
            input,
            Kind::Document,
            "document_id",
            command.contains(".star_"),
        ),
        "core.move_document" => document_move(world, cx, input),
        "core.create_folder" => folder_create(world, cx, input),
        "core.rename_folder" => {
            let id = text(input, "folder_id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Folder, id.to_owned())) {
                Some(row) => {
                    row.name = text(input, "name").unwrap_or_default().to_owned();
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"folder_id": id})))
                }
                None => Ok(refused(
                    "folder_exists_and_not_root",
                    "there is no folder with that id — the drive's own top level is not a folder",
                )),
            }
        }
        "core.delete_folder" => folder_delete(world, input),
        "media.update_asset" => photo_update(world, cx, input),
        "media.delete_asset" => {
            let id = text(input, "asset_id").unwrap_or_default().to_owned();
            let ran = trash_row(
                world,
                cx,
                input,
                Kind::Photo,
                "asset_id",
                "asset_exists_live",
                "that photograph is already in the trash",
            )?;
            if ran.ok {
                // the vault takes a trashed photo out of its albums
                unlink(world, |edge| {
                    !(edge.via == Via::Entry && edge.to == (Kind::Photo, id.clone()))
                });
            }
            Ok(ran)
        }
        "media.restore_asset" => restore_row(
            world,
            cx,
            input,
            Kind::Photo,
            "asset_id",
            "asset_is_trashed_within_its_window",
            "that photograph is not in the trash, or its thirty days have run out",
        ),
        "media.set_favorite" => star(
            world,
            input,
            Kind::Photo,
            "asset_id",
            int(input, "favorite") == Some(1),
        ),
        "media.create_album" => {
            let id = text(input, "album_id").map_or_else(|| cx.id("album_id"), str::to_owned);
            if world.rows.keys().any(|(_, row)| *row == id) {
                return Ok(refused(
                    "minted_id_is_free",
                    "an album with that id already exists",
                ));
            }
            let row = new_row(
                Kind::Album,
                &id,
                text(input, "title").unwrap_or_default(),
                cx,
            );
            world.rows.insert(row.key(), row);
            Ok(ok(json!({"album_id": id})))
        }
        "media.rename_album" => {
            let id = text(input, "album_id").unwrap_or_default();
            match world.rows.get_mut(&(Kind::Album, id.to_owned())) {
                Some(row) => {
                    row.name = text(input, "title").unwrap_or_default().to_owned();
                    row.updated = cx.now.clone();
                    Ok(ok(json!({"album_id": id})))
                }
                None => Ok(refused("album_exists", "there is no album with that id")),
            }
        }
        "media.delete_album" => {
            let id = text(input, "album_id").unwrap_or_default().to_owned();
            let key = (Kind::Album, id.clone());
            let Some(row) = world.rows.remove(&key) else {
                return Ok(refused("album_exists", "there is no album with that id"));
            };
            let revision = cx.id("revision_id");
            let held: Vec<Edge> = world
                .edges
                .iter()
                .filter(|edge| edge.via == Via::Entry && edge.from == key)
                .cloned()
                .collect();
            unlink(world, |edge| !(edge.from == key || edge.to == key));
            bin.insert(revision.clone(), (row, held));
            Ok(ok(json!({"album_id": id, "revision_id": revision})))
        }
        "media.restore_album" => {
            let id = text(input, "album_id").unwrap_or_default();
            let revision = text(input, "revision_id").unwrap_or_default();
            if world.rows.contains_key(&(Kind::Album, id.to_owned())) {
                return Ok(refused("album_is_absent", "that album is already there"));
            }
            let Some((mut row, held)) = bin.remove(revision) else {
                return Ok(refused(
                    "revision_is_this_albums_and_not_undone",
                    "that undo record is not this album's, or it has already been used",
                ));
            };
            row.updated = cx.now.clone();
            world.rows.insert(row.key(), row);
            for held in held {
                edge(world, held.from, held.to, held.via);
            }
            Ok(ok(json!({"album_id": id, "revision_id": revision})))
        }
        "media.add_to_album" => {
            let album = (
                Kind::Album,
                text(input, "album_id").unwrap_or_default().to_owned(),
            );
            let photo = (
                Kind::Photo,
                text(input, "asset_id").unwrap_or_default().to_owned(),
            );
            if !world.rows.contains_key(&album) {
                return Ok(refused("album_exists", "there is no album with that id"));
            }
            if !world.rows.contains_key(&photo) {
                return Ok(refused(
                    "asset_exists",
                    "there is no photograph with that id",
                ));
            }
            if world
                .edges
                .iter()
                .any(|e| e.via == Via::Entry && e.from == album && e.to == photo)
            {
                return Ok(refused(
                    "not_already_in_album",
                    "that photograph is already in this album",
                ));
            }
            edge(world, album, photo, Via::Entry);
            Ok(ok(json!({"entry_id": cx.id("entry_id"), "position": 0})))
        }
        "media.remove_from_album" => {
            let album = (
                Kind::Album,
                text(input, "album_id").unwrap_or_default().to_owned(),
            );
            let photo = (
                Kind::Photo,
                text(input, "asset_id").unwrap_or_default().to_owned(),
            );
            if !world
                .edges
                .iter()
                .any(|e| e.via == Via::Entry && e.from == album && e.to == photo)
            {
                return Ok(refused(
                    "entry_exists",
                    "that photograph is not in this album",
                ));
            }
            unlink(world, |e| {
                !(e.via == Via::Entry && e.from == album && e.to == photo)
            });
            Ok(ok(json!({"album_id": album.1, "asset_id": photo.1})))
        }
        "tally.create_group" => group_create(world, cx, input),
        "tally.rename_group" => {
            let id = text(input, "group_id").unwrap_or_default();
            let name = text(input, "name").unwrap_or_default().to_owned();
            match world.rows.get_mut(&(Kind::Group, id.to_owned())) {
                Some(row) => {
                    row.name.clone_from(&name);
                    row.updated = cx.now.clone();
                    if let Some(group) = world.tally.groups.iter_mut().find(|g| g.group_id == id) {
                        group.name = name;
                    }
                    Ok(ok(json!({"group_id": id})))
                }
                None => Ok(refused("group_exists", "there is no group with that id")),
            }
        }
        "tally.delete_group" => group_delete(world, input),
        "tally.add_group_member" => group_member(world, input, true),
        "tally.remove_group_member" => group_member(world, input, false),
        "tally.settle_up" => settle_up(world, cx, input),
        "locker.add_item" => locker_add(world, cx, input),
        "locker.edit_item" => locker_edit(world, cx, input),
        "locker.trash_item" => trash_row(
            world,
            cx,
            input,
            Kind::LockerItem,
            "item_id",
            "item_live",
            "that item is not in your locker",
        ),
        "locker.restore_item" => restore_row(
            world,
            cx,
            input,
            Kind::LockerItem,
            "item_id",
            "item_trashed_within_window",
            "that item is not in the trash, or its 30 days have run out",
        ),
        "locker.star_item" | "locker.unstar_item" => star(
            world,
            input,
            Kind::LockerItem,
            "item_id",
            command == "locker.star_item",
        ),
        "locker.reveal_receipt" => Ok(ok(json!({"receipt_id": cx.id("receipt_id")}))),
        other => Err(format!(
            "error: park has no patch for {other}; the write cannot be shown before it is made."
        )),
    }
}

// ---------------------------------------------------------------------
// the shared shapes
// ---------------------------------------------------------------------

fn trash_row(
    world: &mut World,
    cx: &Cx,
    input: &Value,
    kind: Kind,
    param: &str,
    predicate: &str,
    sentence: &str,
) -> Result<Ran, String> {
    let id = text(input, param).unwrap_or_default();
    match world.rows.get_mut(&(kind, id.to_owned())) {
        Some(row) if !row.trashed => {
            trash(row, cx);
            let mut out = json!({ param: id });
            if kind == Kind::Task {
                out["removed"] = json!(1);
            }
            Ok(ok(out))
        }
        _ => Ok(refused(predicate, sentence)),
    }
}

fn restore_row(
    world: &mut World,
    cx: &Cx,
    input: &Value,
    kind: Kind,
    param: &str,
    predicate: &str,
    sentence: &str,
) -> Result<Ran, String> {
    let id = text(input, param).unwrap_or_default();
    match world.rows.get_mut(&(kind, id.to_owned())) {
        Some(row) if row.trashed && window_open(row, &cx.now) => {
            untrash(row, cx);
            Ok(ok(json!({ param: id })))
        }
        _ => Ok(refused(predicate, sentence)),
    }
}

fn star(
    world: &mut World,
    input: &Value,
    kind: Kind,
    param: &str,
    on: bool,
) -> Result<Ran, String> {
    let id = text(input, param).unwrap_or_default();
    match world.rows.get_mut(&(kind, id.to_owned())) {
        Some(row) if !row.trashed => {
            row.fields.insert("starred", Val::Bool(on));
            Ok(ok(json!({ param: id })))
        }
        _ => Ok(refused("live", "That row is not here.")),
    }
}

// ---------------------------------------------------------------------
// people
// ---------------------------------------------------------------------

fn people_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "party_id").map_or_else(|| cx.id("party_id"), str::to_owned);
    if world.rows.contains_key(&(Kind::Person, id.clone())) {
        return Ok(refused(
            "minted_id_is_free",
            "a person already holds the id this write minted",
        ));
    }
    let mut row = new_row(
        Kind::Person,
        &id,
        text(input, "display_name").unwrap_or_default(),
        cx,
    );
    put(
        &mut row,
        "role",
        nonempty(text(input, "role").unwrap_or_default()),
    );
    put(
        &mut row,
        "nickname",
        nonempty(text(input, "nickname").unwrap_or_default()),
    );
    put(
        &mut row,
        "cadence",
        int(input, "cadence_days")
            .filter(|days| *days > 0)
            .map(Val::Num),
    );
    row.fields.insert("starred", Val::Bool(false));
    row.extra.insert("profile", "yes".to_owned());
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"party_id": id})))
}

fn people_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "party_id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Person, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("person_live", "That person is not here."));
    };
    if let Some(name) = text(input, "display_name") {
        row.name = name.to_owned();
    }
    for (key, field) in [("role", "role"), ("nickname", "nickname"), ("met", "met")] {
        if let Some(value) = text(input, key) {
            put(row, field, nonempty(value));
        }
    }
    if let Some(days) = int(input, "cadence_days") {
        put(
            row,
            "cadence",
            Some(days).filter(|days| *days > 0).map(Val::Num),
        );
    }
    row.updated = cx.now.clone();
    Ok(ok(
        json!({"party_id": id, "revision_id": cx.id("revision_id")}),
    ))
}

fn debt_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let person = text(input, "party_id").unwrap_or_default().to_owned();
    if !world.rows.contains_key(&(Kind::Person, person.clone())) {
        return Ok(refused("person_exists", "That person is not here."));
    }
    if person == world.me {
        return Ok(refused(
            "not_the_owner_themselves",
            "a debt needs two people; this is you",
        ));
    }
    let id = cx.id("debt_id");
    let owes = text(input, "direction") == Some("owe");
    let mut row = new_row(Kind::Debt, &id, text(input, "reason").unwrap_or("debt"), cx);
    row.date = cx.stamp().map(|stamp| Stamp {
        date: stamp.date,
        time: None,
    });
    row.fields.insert(
        "amount",
        Val::Money(
            int(input, "amount_minor").unwrap_or_default(),
            world.currency.clone(),
        ),
    );
    row.fields.insert(
        "direction",
        Val::Enum(if owes { "i_owe" } else { "owes_me" }),
    );
    row.fields.insert("status", Val::Enum("open"));
    world.rows.insert(row.key(), row);
    edge(
        world,
        (Kind::Debt, id.clone()),
        (Kind::Person, person.clone()),
        Via::Counterparty,
    );
    if !world.tally.friends.contains(&person) {
        world.tally.friends.push(person);
    }
    Ok(ok(json!({"debt_id": id})))
}

// ---------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------

fn project_save(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "project_id").map_or_else(|| cx.id("project_id"), str::to_owned);
    let name = text(input, "name").unwrap_or_default();
    let key = (Kind::List, id.clone());
    let mut row = world
        .rows
        .remove(&key)
        .unwrap_or_else(|| new_row(Kind::List, &id, name, cx));
    row.name = name.to_owned();
    // the upsert writes the area it is given and nulls the rest
    put(
        &mut row,
        "area",
        nonempty(text(input, "area").unwrap_or_default()),
    );
    row.updated = cx.now.clone();
    world.rows.insert(key, row);
    Ok(ok(json!({"project_id": id})))
}

fn task_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "task_id").map_or_else(|| cx.id("task_id"), str::to_owned);
    if let Some(parent) = text(input, "parent_task_id") {
        let top_level = world.parent_of(&(Kind::Task, parent.to_owned())).is_none();
        let open = live(world, Kind::Task, parent).is_some_and(|row| {
            matches!(row.field("status"), Some(Val::Enum("open" | "in_progress")))
        });
        if !(top_level && open) {
            return Ok(refused(
                "parent_open_and_top_level",
                "That parent is not an open, top-level task.",
            ));
        }
    }
    let mut row = new_row(
        Kind::Task,
        &id,
        text(input, "title").unwrap_or_default(),
        cx,
    );
    row.fields.insert("status", Val::Enum("open"));
    row.date = text(input, "due_at").and_then(Stamp::parse);
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
    if let Some(rule) = text(input, "rrule") {
        row.extra.insert("rrule", rule.to_owned());
    }
    world.rows.insert(row.key(), row);
    if let Some(parent) = text(input, "parent_task_id") {
        edge(
            world,
            (Kind::Task, parent.to_owned()),
            (Kind::Task, id.clone()),
            Via::Subtask,
        );
    }
    Ok(ok(json!({"task_id": id})))
}

fn task_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "task_id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Task, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("task_exists", "That task is not here."));
    };
    if let Some(title) = text(input, "title") {
        row.name = title.to_owned();
    }
    if let Some(description) = text(input, "description") {
        put(row, "description", nonempty(description));
    }
    if flag(input, "clear_description") {
        put(row, "description", None);
    }
    if let Some(due) = text(input, "due_at") {
        row.date = Stamp::parse(due);
    }
    if flag(input, "clear_due") {
        row.date = None;
    }
    if let Some(priority) = int(input, "priority") {
        put(
            row,
            "priority",
            Some(priority).filter(|value| *value > 0).map(Val::Num),
        );
    }
    if let Some(effort) = int(input, "effort_min") {
        put(row, "effort", Some(Val::Num(effort)));
    }
    if flag(input, "clear_effort") {
        put(row, "effort", None);
    }
    if let Some(rule) = text(input, "rrule") {
        row.extra.insert("rrule", rule.to_owned());
    }
    if flag(input, "clear_rrule") {
        row.extra.remove("rrule");
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"task_id": id})))
}

fn task_status(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "task_id").unwrap_or_default();
    let status = text(input, "status").unwrap_or_default();
    let stamp = cx.stamp();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Task, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("task_exists", "That task is not here."));
    };
    let model = match status {
        "completed" => "completed",
        "cancelled" => "cancelled",
        "in-process" => "in_progress",
        _ => "open",
    };
    let already = row.field("status") == Some(&Val::Enum(model));
    if !already {
        row.fields.insert("status", Val::Enum(model));
        // `completed_at` exists iff the status says completed
        put(
            row,
            "completed",
            (model == "completed")
                .then_some(stamp)
                .flatten()
                .map(Val::Date),
        );
        row.updated = cx.now.clone();
    }
    Ok(ok(
        json!({"task_id": id, "status": status, "series_id": Value::Null}),
    ))
}

fn task_delete(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "task_id").unwrap_or_default().to_owned();
    if live(world, Kind::Task, &id).is_none() {
        return Ok(refused("task_exists", "That task is not here."));
    }
    let parent = (Kind::Task, id.clone());
    let mut keys = vec![parent.clone()];
    keys.extend(
        world
            .edges
            .iter()
            .filter(|edge| edge.via == Via::Subtask && edge.from == parent)
            .map(|edge| edge.to.clone()),
    );
    let mut removed = 0;
    for key in keys {
        if let Some(row) = world.rows.get_mut(&key).filter(|row| !row.trashed) {
            trash(row, cx);
            removed += 1;
        }
    }
    Ok(ok(json!({"task_id": id, "removed": removed})))
}

fn task_restore(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "task_id").unwrap_or_default().to_owned();
    let key = (Kind::Task, id.clone());
    if !world
        .rows
        .get(&key)
        .is_some_and(|row| row.trashed && window_open(row, &cx.now))
    {
        return Ok(refused(
            "task_trashed",
            "That task is not in the trash any more.",
        ));
    }
    let mut keys = vec![key.clone()];
    keys.extend(
        world
            .edges
            .iter()
            .filter(|edge| edge.via == Via::Subtask && edge.from == key)
            .map(|edge| edge.to.clone()),
    );
    let mut restored = 0;
    for key in keys {
        if let Some(row) = world.rows.get_mut(&key).filter(|row| row.trashed) {
            untrash(row, cx);
            restored += 1;
        }
    }
    Ok(ok(json!({"task_id": id, "restored": restored})))
}

fn task_organize(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "task_id").unwrap_or_default().to_owned();
    let task = (Kind::Task, id.clone());
    if !world.rows.contains_key(&task) {
        return Ok(refused("task_exists", "That task is not here."));
    }
    let project = text(input, "project_id").map(|project| (Kind::List, project.to_owned()));
    if let Some(project) = &project
        && !world.rows.contains_key(project)
    {
        return Ok(refused("project_exists", "There is no such list."));
    }
    if flag(input, "clear_project") || project.is_some() {
        unlink(world, |edge| {
            !(edge.via == Via::ListColumn && edge.to == task)
        });
    }
    if let Some(project) = project {
        edge(world, project, task, Via::ListColumn);
    }
    Ok(ok(json!({"task_id": id})))
}

fn span_clash(world: &World, start: &str, end: &str) -> bool {
    world.of_kind(Kind::Event).any(|event| {
        event.field("status") != Some(&Val::Enum("cancelled"))
            && event.extra.get("dtstart").is_some_and(|s| s.as_str() < end)
            && event.extra.get("dtend").is_none_or(|e| e.as_str() > start)
    })
}

fn event_propose(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "event_id").map_or_else(|| cx.id("event_id"), str::to_owned);
    let start = text(input, "dtstart").unwrap_or_default();
    let end = text(input, "dtend").unwrap_or_default();
    if world.rows.contains_key(&(Kind::Event, id.clone())) {
        return Ok(refused(
            "event_id_free",
            "an event with that id already exists",
        ));
    }
    if span_clash(world, start, end) {
        return Ok(refused(
            "no_busy_conflict",
            "This time conflicts with another event on your calendar.",
        ));
    }
    if end <= start {
        return Ok(refused(
            "dtend_after_dtstart",
            "An event must end after it starts.",
        ));
    }
    let mut row = new_row(
        Kind::Event,
        &id,
        text(input, "summary").unwrap_or_default(),
        cx,
    );
    row.fields.insert("status", Val::Enum("tentative"));
    shape_event(&mut row, start, Some(end));
    put(
        &mut row,
        "description",
        nonempty(text(input, "description").unwrap_or_default()),
    );
    row.extra.insert("dtstart", start.to_owned());
    row.extra.insert("dtend", end.to_owned());
    world.rows.insert(row.key(), row);
    let attendees = input
        .get("attendee_party_ids")
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
    Ok(ok(json!({"event_id": id, "attendees": attendees.len()})))
}

fn event_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "event_id").unwrap_or_default();
    let Some(row) = world.rows.get_mut(&(Kind::Event, id.to_owned())) else {
        return Ok(refused("event_exists", "That event is not here to edit."));
    };
    if let Some(summary) = text(input, "summary") {
        row.name = summary.to_owned();
    }
    if let Some(description) = text(input, "description") {
        put(row, "description", nonempty(description));
    }
    if flag(input, "clear_description") {
        put(row, "description", None);
    }
    let start = text(input, "dtstart")
        .map(str::to_owned)
        .or_else(|| row.extra.get("dtstart").cloned());
    let end = text(input, "dtend")
        .map(str::to_owned)
        .or_else(|| row.extra.get("dtend").cloned());
    if text(input, "dtstart").is_some() || text(input, "dtend").is_some() {
        if let (Some(start), Some(end)) = (&start, &end)
            && end <= start
        {
            return Ok(refused(
                "event_end_after_start",
                "An event must end after it starts.",
            ));
        }
        if let Some(start) = &start {
            shape_event(row, start, end.as_deref());
            row.extra.insert("dtstart", start.clone());
        }
        if let Some(end) = &end {
            row.extra.insert("dtend", end.clone());
        }
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"event_id": id, "sequence": 1})))
}

fn event_reschedule(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "event_id").unwrap_or_default();
    let start = text(input, "dtstart").unwrap_or_default();
    let end = text(input, "dtend").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Event, id.to_owned()))
        .filter(|row| !row.trashed && row.field("status") != Some(&Val::Enum("cancelled")))
    else {
        return Ok(refused(
            "event_exists_not_cancelled",
            "That event is not here to change.",
        ));
    };
    if end <= start {
        return Ok(refused(
            "dtend_after_dtstart",
            "An event must end after it starts.",
        ));
    }
    shape_event(row, start, Some(end));
    row.extra.insert("dtstart", start.to_owned());
    row.extra.insert("dtend", end.to_owned());
    row.updated = cx.now.clone();
    Ok(ok(json!({"event_id": id, "sequence": 1})))
}

// ---------------------------------------------------------------------
// notes and notebooks
// ---------------------------------------------------------------------

fn note_create(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "note_id").map_or_else(|| cx.id("note_id"), str::to_owned);
    if world.rows.contains_key(&(Kind::Note, id.clone())) {
        return Ok(refused(
            "note_id_is_free",
            "a note already holds the id this write minted",
        ));
    }
    if let Some(notebook) = text(input, "notebook_id")
        && !world
            .rows
            .contains_key(&(Kind::Notebook, notebook.to_owned()))
    {
        return Ok(refused(
            "notebook_exists_if_given",
            "there is no notebook with that id",
        ));
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
        nonempty(text(input, "body_text").unwrap_or_default()),
    );
    row.fields.insert("pinned", Val::Bool(false));
    world.rows.insert(row.key(), row);
    if let Some(notebook) = text(input, "notebook_id") {
        edge(
            world,
            (Kind::Notebook, notebook.to_owned()),
            (Kind::Note, id.clone()),
            Via::Entry,
        );
    }
    Ok(ok(
        json!({"note_id": id, "body_content_id": cx.id("body_content_id")}),
    ))
}

fn note_edit(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "note_id").unwrap_or_default();
    let Some(row) = world
        .rows
        .get_mut(&(Kind::Note, id.to_owned()))
        .filter(|row| !row.trashed)
    else {
        return Ok(refused("note_is_live", "That note is not here."));
    };
    if let Some(body) = text(input, "body_text") {
        put(row, "body", nonempty(body));
    }
    if let Some(title) = text(input, "title") {
        row.name = title.to_owned();
    }
    if let Some(pinned) = int(input, "pinned") {
        row.fields.insert("pinned", Val::Bool(pinned == 1));
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"note_id": id})))
}

fn note_move(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "note_id").unwrap_or_default().to_owned();
    let note = (Kind::Note, id.clone());
    if live(world, Kind::Note, &id).is_none() {
        return Ok(refused("note_is_live", "That note is not here."));
    }
    let notebook = text(input, "notebook_id").map(|notebook| (Kind::Notebook, notebook.to_owned()));
    if let Some(notebook) = &notebook
        && !world.rows.contains_key(notebook)
    {
        return Ok(refused(
            "notebook_exists_if_given",
            "there is no notebook with that id",
        ));
    }
    unlink(world, |edge| !(edge.via == Via::Entry && edge.to == note));
    if let Some(notebook) = notebook {
        edge(world, notebook, note, Via::Entry);
    }
    Ok(ok(json!({"note_id": id})))
}

fn notebook_create(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "notebook_id").map_or_else(|| cx.id("notebook_id"), str::to_owned);
    let name = text(input, "name").unwrap_or_default();
    if world.rows.keys().any(|(_, row)| *row == id) {
        return Ok(refused(
            "notebook_id_is_free",
            "a notebook already holds the id this write minted",
        ));
    }
    if world.of_kind(Kind::Notebook).any(|row| row.name == name) {
        return Ok(refused(
            "name_unused",
            "You already have a notebook with that name.",
        ));
    }
    let mut row = new_row(Kind::Notebook, &id, name, cx);
    if let Some(parent) = text(input, "parent_notebook_id") {
        row.extra.insert("parent", parent.to_owned());
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"notebook_id": id})))
}

fn notebook_rename(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "notebook_id").unwrap_or_default();
    let name = text(input, "name").unwrap_or_default().to_owned();
    if !world.rows.contains_key(&(Kind::Notebook, id.to_owned())) {
        return Ok(refused(
            "notebook_exists",
            "there is no notebook with that id",
        ));
    }
    if world
        .of_kind(Kind::Notebook)
        .any(|row| row.name == name && row.id != id)
    {
        return Ok(refused(
            "name_unused_by_owner",
            "You already have a notebook with that name.",
        ));
    }
    if let Some(row) = world.rows.get_mut(&(Kind::Notebook, id.to_owned())) {
        row.name = name;
    }
    Ok(ok(json!({"notebook_id": id})))
}

fn notebook_delete(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "notebook_id").unwrap_or_default().to_owned();
    let key = (Kind::Notebook, id.clone());
    if !world.rows.contains_key(&key) {
        return Ok(refused(
            "notebook_exists",
            "there is no notebook with that id",
        ));
    }
    if world
        .of_kind(Kind::Notebook)
        .any(|row| row.extra.get("parent") == Some(&id))
    {
        return Ok(refused(
            "notebook_has_no_children",
            "That notebook still holds notebooks; delete or move them first.",
        ));
    }
    let unfiled = world
        .edges
        .iter()
        .filter(|e| e.via == Via::Entry && e.from == key)
        .count();
    unlink(world, |edge| !(edge.from == key || edge.to == key));
    world.rows.remove(&key);
    Ok(ok(json!({"notebook_id": id, "notes_unfiled": unfiled})))
}

// ---------------------------------------------------------------------
// documents and folders
// ---------------------------------------------------------------------

fn document_add(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "document_id").map_or_else(|| cx.id("document_id"), str::to_owned);
    if world.rows.contains_key(&(Kind::Document, id.clone())) {
        return Ok(refused(
            "document_id_is_free",
            "a document already holds the id this write minted",
        ));
    }
    if let Some(folder) = text(input, "folder_id")
        && !world.rows.contains_key(&(Kind::Folder, folder.to_owned()))
        && world.root_folder.as_deref() != Some(folder)
    {
        return Ok(refused(
            "folder_exists_if_given",
            "there is no folder with that id",
        ));
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
            Via::FolderTag,
        );
    }
    Ok(ok(
        json!({"document_id": id, "content_id": cx.id("content_id"), "deduped": false}),
    ))
}

fn document_move(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "document_id").unwrap_or_default().to_owned();
    let document = (Kind::Document, id.clone());
    if live(world, Kind::Document, &id).is_none() {
        return Ok(refused("document_live", "That document is not here."));
    }
    let folder = text(input, "folder_id").map(|folder| (Kind::Folder, folder.to_owned()));
    if let Some(folder) = &folder
        && !world.rows.contains_key(folder)
    {
        return Ok(refused(
            "folder_exists_if_given",
            "there is no folder with that id",
        ));
    }
    unlink(world, |edge| {
        !(edge.via == Via::FolderTag && edge.to == document)
    });
    if let Some(folder) = folder {
        edge(world, folder, document.clone(), Via::FolderTag);
    }
    if let Some(row) = world.rows.get_mut(&document) {
        row.updated = cx.now.clone();
    }
    Ok(ok(json!({"document_id": id})))
}

fn folder_create(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "folder_id").map_or_else(|| cx.id("folder_id"), str::to_owned);
    let name = text(input, "name").unwrap_or_default();
    let parent = text(input, "parent_folder_id").map(str::to_owned);
    if let Some(parent) = &parent
        && !world.rows.contains_key(&(Kind::Folder, parent.clone()))
    {
        return Ok(refused(
            "parent_exists_if_given",
            "there is no folder with that parent id",
        ));
    }
    // siblings: the folders under the same parent, the top level when none is given
    let root = world.root_folder.clone();
    let top = |row: &Row| {
        row.extra
            .get("parent")
            .is_none_or(|parent| Some(parent) == root.as_ref())
    };
    let clash = world.of_kind(Kind::Folder).any(|row| {
        row.name == name
            && match &parent {
                None => top(row),
                Some(parent) => row.extra.get("parent") == Some(parent),
            }
    });
    if clash {
        return Ok(refused(
            "name_unused_among_siblings",
            &format!("there is already a folder called \"{name}\" there"),
        ));
    }
    let mut row = new_row(Kind::Folder, &id, name, cx);
    if let Some(parent) = parent.or(root) {
        row.extra.insert("parent", parent);
    }
    world.rows.insert(row.key(), row);
    Ok(ok(json!({"folder_id": id})))
}

fn folder_delete(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "folder_id").unwrap_or_default().to_owned();
    let key = (Kind::Folder, id.clone());
    if !world.rows.contains_key(&key) {
        return Ok(refused(
            "folder_exists_and_not_root",
            "there is no folder with that id — the drive's own top level is not a folder",
        ));
    }
    let holds = world
        .edges
        .iter()
        .any(|edge| edge.via == Via::FolderTag && edge.from == key)
        || world
            .of_kind(Kind::Folder)
            .any(|row| row.extra.get("parent") == Some(&id));
    if holds {
        return Ok(refused(
            "folder_is_empty",
            "that folder still holds documents or subfolders — a trashed document counts, because it keeps its folder",
        ));
    }
    world.rows.remove(&key);
    Ok(ok(json!({"folder_id": id})))
}

// ---------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------

fn photo_update(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "asset_id").unwrap_or_default();
    let Some(row) = world.rows.get_mut(&(Kind::Photo, id.to_owned())) else {
        return Ok(refused(
            "asset_exists",
            "there is no photograph with that id",
        ));
    };
    if let Some(captured) = text(input, "captured_at") {
        row.date = Stamp::parse(captured);
    }
    if let Some(favorite) = int(input, "favorite") {
        row.fields.insert("starred", Val::Bool(favorite == 1));
    }
    if let Some(title) = text(input, "title") {
        row.name = if title.is_empty() {
            "untitled".to_owned()
        } else {
            title.to_owned()
        };
    }
    row.updated = cx.now.clone();
    Ok(ok(json!({"asset_id": id})))
}

// ---------------------------------------------------------------------
// tally
// ---------------------------------------------------------------------

fn group_create(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let id = text(input, "group_id").map_or_else(|| cx.id("group_id"), str::to_owned);
    let name = text(input, "name").unwrap_or_default();
    if world.of_kind(Kind::Group).any(|row| row.name == name) {
        return Err(format!(
            "tally.create_group: invalid input: name: a circle named \"{name}\" already exists"
        ));
    }
    let currency =
        text(input, "currency").map_or_else(|| world.currency.clone(), str::to_uppercase);
    let mut row = new_row(Kind::Group, &id, name, cx);
    row.fields.insert("currency", Val::Text(currency.clone()));
    row.extra.insert("currency", currency.clone());
    world.rows.insert(row.key(), row);
    let mut members = vec![world.me.clone()];
    for member in input
        .get("member_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !members.iter().any(|have| have == member) {
            members.push(member.to_owned());
        }
    }
    for member in &members {
        edge(
            world,
            (Kind::Group, id.clone()),
            (Kind::Person, member.clone()),
            Via::Membership,
        );
    }
    members.sort();
    world.tally.members_by_group.insert(id.clone(), members);
    world.tally.groups.push(GroupRow {
        group_id: id.clone(),
        circle_id: (cx.mint)(),
        name: name.to_owned(),
        icon: text(input, "icon").unwrap_or_default().to_owned(),
        color: text(input, "color").unwrap_or("#0FA678").to_owned(),
        currency,
        simplify_opt_in: false,
        archived_at: None,
    });
    Ok(ok(json!({"group_id": id})))
}

fn group_delete(world: &mut World, input: &Value) -> Result<Ran, String> {
    let id = text(input, "group_id").unwrap_or_default().to_owned();
    let key = (Kind::Group, id.clone());
    if !world.rows.contains_key(&key) {
        return Ok(refused("group_exists", "there is no group with that id"));
    }
    if world
        .tally
        .expenses
        .iter()
        .any(|expense| expense.group_id.as_deref() == Some(id.as_str()))
    {
        return Ok(refused(
            "group_empty",
            "this group still has expenses; a group with money in it is not deleted",
        ));
    }
    world.rows.remove(&key);
    unlink(world, |edge| !(edge.from == key || edge.to == key));
    world.tally.groups.retain(|group| group.group_id != id);
    world.tally.members_by_group.remove(&id);
    world
        .tally
        .settlements
        .retain(|settlement| settlement.group_id.as_deref() != Some(id.as_str()));
    Ok(ok(json!({"group_id": id})))
}

fn group_member(world: &mut World, input: &Value, add: bool) -> Result<Ran, String> {
    let group = text(input, "group_id").unwrap_or_default().to_owned();
    let party = text(input, "party_id").unwrap_or_default().to_owned();
    let key = (Kind::Group, group.clone());
    if !world.rows.contains_key(&key) {
        return Ok(refused("group_exists", "there is no group with that id"));
    }
    if add {
        let members = world
            .tally
            .members_by_group
            .entry(group.clone())
            .or_default();
        if !members.contains(&party) {
            members.push(party.clone());
            members.sort();
        }
        edge(world, key, (Kind::Person, party), Via::Membership);
        return Ok(ok(json!({"group_id": group})));
    }
    let net = centraid_apps_tally::balance::group_net(&world.tally.balance_data(), &group);
    if net.get(&party).copied().unwrap_or(0) != 0 {
        return Ok(refused(
            "member_off_ledger",
            "this member still has an unsettled balance in this group; settle up first, or the group keeps their history",
        ));
    }
    if party == world.me {
        return Err(
            "tally.remove_group_member: invalid input: party_id: you cannot remove yourself from a group; leave it instead"
                .to_owned(),
        );
    }
    if let Some(members) = world.tally.members_by_group.get_mut(&group) {
        members.retain(|member| *member != party);
    }
    unlink(world, |edge| {
        !(edge.via == Via::Membership
            && edge.from == key
            && edge.to == (Kind::Person, party.clone()))
    });
    Ok(ok(json!({"group_id": group})))
}

fn settle_up(world: &mut World, cx: &Cx, input: &Value) -> Result<Ran, String> {
    let group = text(input, "group_id").map(str::to_owned);
    let id = cx.id("settlement_id");
    world.tally.settlements.push(SettlementRow {
        settlement_id: id.clone(),
        group_id: group,
        from_party: text(input, "from_party").unwrap_or_default().to_owned(),
        to_party: text(input, "to_party").unwrap_or_default().to_owned(),
        amount_minor: int(input, "amount_minor").unwrap_or_default(),
        currency: text(input, "currency").map(str::to_owned),
        paid_on: text(input, "paid_on").map(str::to_owned),
    });
    Ok(ok(json!({"settlement_id": id, "txn_id": Value::Null})))
}

// ---------------------------------------------------------------------
// the session's side
// ---------------------------------------------------------------------

use crate::native::session::Session;

impl Session {
    /// Run one write step: the vault runs it ([`Writes::Run`]), or the patched world takes it
    /// and the step is parked ([`Writes::Park`]), or both ([`Writes::Shadow`]). The clock moves
    /// on first in every mode, so a session's writes land in the order they were made.
    pub(crate) fn write_step(&mut self, command: &str, input: &Value) -> Result<Ran, String> {
        match self.flags.writes {
            Writes::Run => self.door.step(command, input.clone()),
            Writes::Park => {
                self.door.advance();
                let ran = self.patch(command, input, None)?;
                if ran.ok {
                    self.park.steps.push(ParkedStep {
                        command: command.to_owned(),
                        input: input.clone(),
                        output: ran.output.clone(),
                    });
                }
                Ok(ran)
            }
            Writes::Shadow => {
                let real = self.door.step(command, input.clone())?;
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
    pub(crate) fn write_must(&mut self, command: &str, input: Value) -> Result<Value, String> {
        let ran = self.write_step(command, &input)?;
        if ran.ok {
            Ok(ran.output)
        } else {
            Err(format!(
                "{command} refused {input}: {}",
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
                self.world =
                    crate::native::world::World::load_with(&*self.door, self.flags.locker)?;
            }
            Writes::Park => {
                self.world = self
                    .park
                    .world
                    .clone()
                    .ok_or("error: a parking session has no patched world")?;
            }
            Writes::Shadow => {
                let real = crate::native::world::World::load_with(&*self.door, self.flags.locker)?;
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
    let groups = |world: &World| -> Vec<(String, String, String)> {
        let mut groups: Vec<_> = world
            .tally
            .groups
            .iter()
            .map(|g| (g.group_id.clone(), g.name.clone(), g.currency.clone()))
            .collect();
        groups.sort();
        groups
    };
    if groups(patched) != groups(real) {
        out.push(format!(
            "tally groups {:?} / {:?}",
            groups(patched),
            groups(real)
        ));
    }
    let members = |world: &World| -> BTreeMap<String, Vec<String>> {
        world
            .tally
            .members_by_group
            .iter()
            .map(|(group, members)| {
                let mut members = members.clone();
                members.sort();
                (group.clone(), members)
            })
            .collect()
    };
    if members(patched) != members(real) {
        out.push(format!(
            "tally members {:?} / {:?}",
            members(patched),
            members(real)
        ));
    }
    let settlements = |world: &World| -> Vec<String> {
        let mut rows: Vec<String> = world
            .tally
            .settlements
            .iter()
            .map(|s| {
                format!(
                    "{} {:?} {} {} {} {:?} {:?}",
                    s.settlement_id,
                    s.group_id,
                    s.from_party,
                    s.to_party,
                    s.amount_minor,
                    s.currency,
                    s.paid_on
                )
            })
            .collect();
        rows.sort();
        rows
    };
    if settlements(patched) != settlements(real) {
        out.push(format!(
            "tally settlements {:?} / {:?}",
            settlements(patched),
            settlements(real)
        ));
    }
    let friends = |world: &World| -> std::collections::BTreeSet<String> {
        world.tally.friends.iter().cloned().collect()
    };
    if friends(patched) != friends(real) {
        out.push("tally friends differ".to_owned());
    }
    if patched.entity_count != real.entity_count {
        out.push(format!(
            "journal count {} / {}",
            patched.entity_count, real.entity_count
        ));
    }
    out
}

// ---------------------------------------------------------------------
// the Locker (the harness's: the phone's session has none, `Flags::locker`)
// ---------------------------------------------------------------------

/// The columns each Locker type owns; every other is nulled on a write
/// (`centraid_vault::commands::locker::type_fields`, held by `tests/park.rs`).
fn locker_type_fields(item_type: &str) -> &'static [&'static str] {
    match item_type {
        "login" => &["username", "password", "url", "otp_seed", "notes"],
        "card" => &["cardholder", "card_number", "expiry", "cvv", "brand"],
        "note" => &["content"],
        "identity" => &["fullname", "email", "phone", "address"],
        "wifi" => &["network", "password"],
        "password" => &["password"],
        _ => &["notes"],
    }
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
        if !matches!(*name, "key_id" | "purge_at") {
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
        .retain(|name, _| matches!(*name, "key_id" | "purge_at"));
    for (name, value) in columns {
        let sealed = crate::native::meta::REVEAL_FIELDS
            .iter()
            .any(|(_, column)| column == name);
        let plain = crate::native::world::LOCKER_PLAIN.contains(name);
        if (sealed || plain) && !value.is_empty() {
            row.extra.insert(name, value.clone());
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
    Ok(ok(json!({"item_id": id, "template_fields": 0})))
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
    let sealed = ["password", "otp_seed", "card_number", "cvv", "content"];
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
