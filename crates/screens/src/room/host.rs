//! THE ROOM RUNTIME ON A CORE (app-plane §1): the one object the core's `RoomHost` door is. It
//! holds the stacks of rooms behind a lock and, for each call, a door over the core's own
//! context, through which a tap runs a catalogue action and a room reads the backup status.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use centraid_api_proto::core_v1 as wire;
use centraid_core::error::{CoreError, Result};
use centraid_core::rooms::{RoomCtx, RoomHost};
use centraid_domain::action::{ActionDecl, Inverse};
use centraid_domain::catalogue::ACTIONS;
use centraid_vault::CommandStatus;

use super::door::{Done, Door, Refused};
use super::rooms::{Refusal, Rooms};
use super::screen::Registry;
use super::selector::Act;
use crate::strings::{Locale, room as words};

/// The tab a request with none names.
pub const DEFAULT_TAB: &str = "home";

enum UndoRecord {
    Pair { act: Act, input: serde_json::Value },
    Restore(Vec<(String, i64)>),
}

pub struct RoomRuntime {
    rooms: Mutex<Rooms>,
    keys: AtomicU64,
    last: Mutex<Option<UndoRecord>>,
    vault: Mutex<Option<VaultBinding>>,
    platform: Mutex<String>,
    time_zone: Mutex<Option<String>>,
}

type RoomDevice = Arc<centraid_core::device::Checked<centraid_core::device::DirStore>>;

struct VaultBinding {
    id: String,
    device: Option<RoomDevice>,
}

impl RoomRuntime {
    #[must_use]
    pub fn new(registry: Registry) -> Self {
        Self {
            rooms: Mutex::new(Rooms::new(registry)),
            keys: AtomicU64::new(1),
            last: Mutex::new(None),
            vault: Mutex::new(None),
            platform: Mutex::new(String::new()),
            time_zone: Mutex::new(None),
        }
    }

    /// Detect a shelf foreground change while the room lock serializes all runtime entry points.
    /// Kept drafts are device data, so clear only the outgoing vault's registered D1 family.
    fn transition_vault(
        &self,
        ctx: &dyn RoomCtx,
        rooms: &mut Rooms,
    ) -> Option<Vec<super::rooms::Shown>> {
        let current_id = ctx.vault_id();
        let current_device = ctx.device().ok();
        let old = {
            let mut binding = self.vault.lock().unwrap_or_else(PoisonError::into_inner);
            match binding.as_mut() {
                None => {
                    *binding = Some(VaultBinding {
                        id: current_id,
                        device: current_device,
                    });
                    return None;
                }
                Some(previous) if previous.id == current_id => {
                    if previous.device.is_none() {
                        previous.device = current_device;
                    }
                    return None;
                }
                Some(_) => binding.replace(VaultBinding {
                    id: current_id,
                    device: current_device,
                }),
            }
        };
        let old = old.expect("a changed vault binding had a previous value");
        if !old.id.is_empty()
            && let Some(device) = old.device
            && let Ok(keys) = device.list(&format!("draft.{}.", old.id))
        {
            for key in keys {
                let _ = device.delete(&key);
            }
        }
        self.last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        Some(rooms.reset_for_vault(&CtxDoor { ctx, runtime: self }, &old.id))
    }
}

struct CtxDoor<'a> {
    ctx: &'a dyn RoomCtx,
    runtime: &'a RoomRuntime,
}

fn decl_of(name: &str) -> Option<&'static ActionDecl> {
    ACTIONS.iter().find(|decl| decl.name() == name)
}

fn target_ids(input: &serde_json::Value, output: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    let mut push = |id: &str| {
        if !id.is_empty() && !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_owned());
        }
    };
    for source in [input, output] {
        for field in ["id", "entity_id"] {
            if let Some(id) = source.get(field).and_then(serde_json::Value::as_str) {
                push(id);
            }
        }
        if let Some(list) = source.get("ids").and_then(serde_json::Value::as_array) {
            for item in list {
                if let Some(id) = item.as_str() {
                    push(id);
                }
            }
        }
    }
    ids
}

fn latest_revision(ctx: &dyn RoomCtx, entity_id: &str) -> Option<i64> {
    let reader = ctx.reader().ok()?;
    let answer = reader
        .run(
            &centraid_domain::apps::entity::REVISION_HEAD,
            &centraid_domain::read::Args::new().text("id", entity_id),
        )
        .ok()?;
    answer.rows.first().map(|row| row.seq)
}

impl CtxDoor<'_> {
    fn key(&self) -> String {
        format!(
            "room:{}:{}",
            self.ctx.now_ms(),
            self.runtime.keys.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn run_command(
        &self,
        command: &str,
        input: &serde_json::Value,
    ) -> std::result::Result<serde_json::Value, Refused> {
        match self.ctx.command(command, input, &self.key()) {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Ok(outcome.output),
            Ok(outcome) => Err(Refused(
                outcome
                    .reason
                    .unwrap_or_else(|| words::act_refused(Locale::En)),
            )),
            Err(error) => Err(Refused(error.to_string())),
        }
    }
}

impl Door for CtxDoor<'_> {
    fn time_zone(&self) -> Option<centraid_vault::time::FireZone> {
        self.runtime
            .time_zone
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_deref()
            .and_then(|name| centraid_vault::time::FireZone::named(name).ok())
    }

    fn reminders_source(&self) -> bool {
        let platform = self
            .runtime
            .platform
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if platform.is_empty() {
            self.ctx.reminders_source()
        } else {
            *platform != "android"
        }
    }

    fn command_result(
        &self,
        command: &str,
        input: &serde_json::Value,
    ) -> std::result::Result<serde_json::Value, Refused> {
        self.run_command(command, input)
    }

    fn stage_export(&self, bytes: &[u8]) -> std::result::Result<String, Refused> {
        self.ctx
            .stage_room_file(bytes)
            .map_err(|error| Refused(error.to_string()))
    }

    fn stage_archive(&self) -> std::result::Result<String, Refused> {
        self.ctx
            .stage_room_archive()
            .map_err(|error| Refused(error.to_string()))
    }

    fn held_bytes(&self, hash: &str, max_bytes: u64) -> std::result::Result<Vec<u8>, Refused> {
        self.ctx
            .held_bytes(hash, max_bytes)
            .map_err(|error| Refused(error.to_string()))
    }

    fn remove_export(&self, path: &str) {
        self.ctx.remove_room_file(path);
    }

    fn locker_unlocked(&self) -> bool {
        self.ctx.locker_unlocked()
    }

    fn locker_unlock(&self) -> std::result::Result<(u32, Option<String>), Refused> {
        self.ctx
            .locker_unlock()
            .map_err(|error| Refused(error.to_string()))
    }

    fn locker_unlock_failed(&self) -> std::result::Result<u32, Refused> {
        self.ctx
            .locker_unlock_failed()
            .map_err(|error| Refused(error.to_string()))
    }

    fn locker_failed_unlocks(&self) -> std::result::Result<(u32, Option<String>), Refused> {
        self.ctx
            .locker_failed_unlocks()
            .map_err(|error| Refused(error.to_string()))
    }

    fn locker_lock(&self) -> std::result::Result<(), Refused> {
        self.ctx
            .locker_lock()
            .map_err(|error| Refused(error.to_string()))
    }

    fn locker_reveal_field(
        &self,
        item_id: &str,
        field_id: &str,
    ) -> std::result::Result<zeroize::Zeroizing<String>, Refused> {
        self.ctx
            .locker_reveal_field(item_id, field_id)
            .map_err(|error| Refused(error.to_string()))
    }

    fn locker_seal_field(
        &self,
        field_id: &str,
        plaintext: &str,
    ) -> std::result::Result<(String, String), Refused> {
        self.ctx
            .locker_seal_field(field_id, plaintext)
            .map_err(|error| Refused(error.to_string()))
    }

    fn act(&self, act: &Act) -> std::result::Result<Done, Refused> {
        let decl = decl_of(&act.name).ok_or_else(|| Refused(words::act_refused(Locale::En)))?;
        let before: Vec<(String, i64)> = if matches!(decl.inverse, Inverse::Restore) {
            target_ids(&act.input, &serde_json::Value::Null)
                .into_iter()
                .map(|id| {
                    let seq = latest_revision(self.ctx, &id).unwrap_or(0);
                    (id, seq)
                })
                .collect()
        } else {
            Vec::new()
        };
        let output = self.run_command(decl.command, &act.input)?;
        let record = match decl.inverse {
            Inverse::Pair(inverse_name) => {
                let mut input = act.input.clone();
                if let Some(changed_ids) = output
                    .get("changed_ids")
                    .and_then(serde_json::Value::as_array)
                {
                    if changed_ids.is_empty() {
                        None
                    } else {
                        if let Some(object) = input.as_object_mut() {
                            object.remove("id");
                            object.insert(
                                "ids".to_owned(),
                                serde_json::Value::Array(changed_ids.clone()),
                            );
                        }
                        Some(UndoRecord::Pair {
                            act: act.clone(),
                            input,
                        })
                    }
                } else {
                    if inverse_name == "entity.trash"
                        && input.get("id").is_none()
                        && input.get("ids").is_none()
                        && let Some(id) = output.get("id").and_then(serde_json::Value::as_str)
                    {
                        input = serde_json::json!({ "ids": [id] });
                    }
                    Some(UndoRecord::Pair {
                        act: act.clone(),
                        input,
                    })
                }
            }
            Inverse::Restore => {
                let mut pairs = Vec::new();
                for id in target_ids(&act.input, &output) {
                    let prev = before
                        .iter()
                        .find(|(b, _)| b == &id)
                        .map_or(0, |(_, seq)| *seq);
                    if let Some(after) = latest_revision(self.ctx, &id)
                        && after > prev
                    {
                        pairs.push((id, after));
                    }
                }
                (!pairs.is_empty()).then_some(UndoRecord::Restore(pairs))
            }
            Inverse::None => None,
        };
        let undo = record.is_some();
        *self
            .runtime
            .last
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = record;
        let sentence = match decl.verb {
            "trash" => words::act_trashed(Locale::En),
            "restore" => words::act_restored(Locale::En),
            _ => words::act_done(Locale::En),
        };
        Ok(Done { sentence, undo })
    }

    fn undo(&self) -> std::result::Result<Done, Refused> {
        let last = self
            .runtime
            .last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(record) = last else {
            return Err(Refused(words::act_refused(Locale::En)));
        };
        match record {
            UndoRecord::Pair { act, input } => {
                let inverse = decl_of(&act.name)
                    .and_then(|decl| match decl.inverse {
                        Inverse::Pair(name) => decl_of(name),
                        _ => None,
                    })
                    .ok_or_else(|| Refused(words::act_refused(Locale::En)))?;
                self.run_command(inverse.command, &input)?;
            }
            UndoRecord::Restore(pairs) => {
                for (id, seq) in &pairs {
                    if latest_revision(self.ctx, id) != Some(*seq) {
                        return Err(Refused(words::act_changed_since(Locale::En)));
                    }
                }
                self.run_command(
                    "history.restore_many",
                    &serde_json::json!({
                        "items": pairs.into_iter().rev().map(|(id, seq)| {
                            serde_json::json!({ "id": id, "seq": seq, "expected_rev": seq })
                        }).collect::<Vec<_>>()
                    }),
                )?;
            }
        }
        Ok(Done {
            sentence: words::act_undone(Locale::En),
            undo: false,
        })
    }

    fn now_ms(&self) -> i64 {
        self.ctx.now_ms()
    }

    fn call(&self, request: &wire::Request) -> std::result::Result<wire::Response, Refused> {
        self.ctx
            .call(request)
            .map_err(|error| Refused(error.to_string()))
    }

    fn device_get(&self, key: &str) -> Option<String> {
        self.ctx.device().ok()?.get(key).ok().flatten()
    }

    fn search(
        &self,
        request: &centraid_search::EachRequest,
    ) -> std::result::Result<Vec<centraid_search::Target>, Refused> {
        self.ctx
            .search(request)
            .map_err(|error| Refused(error.to_string()))
    }

    fn search_page(
        &self,
        request: &centraid_search::SearchRequest,
    ) -> std::result::Result<centraid_search::Answer, Refused> {
        self.ctx
            .search_page(request)
            .map_err(|error| Refused(error.to_string()))
    }

    fn search_correction(
        &self,
        kinds: &[String],
        query: &str,
        thin: bool,
    ) -> std::result::Result<Option<String>, Refused> {
        self.ctx
            .search_correction(kinds, query, thin)
            .map_err(|error| Refused(error.to_string()))
    }

    fn device_put(&self, key: &str, value: &str) -> std::result::Result<(), Refused> {
        self.call(&wire::Request {
            kind: Some(wire::request::Kind::Device(wire::DeviceRequest {
                kind: Some(wire::device_request::Kind::Put(wire::DevicePut {
                    key: key.to_owned(),
                    value: value.to_owned(),
                })),
            })),
        })
        .map(|_| ())
    }

    fn device_delete(&self, key: &str) -> std::result::Result<(), Refused> {
        self.call(&wire::Request {
            kind: Some(wire::request::Kind::Device(wire::DeviceRequest {
                kind: Some(wire::device_request::Kind::Delete(wire::DeviceDelete {
                    key: key.to_owned(),
                })),
            })),
        })
        .map(|_| ())
    }

    fn reader(&self) -> std::result::Result<centraid_domain::read::Reader, Refused> {
        self.ctx
            .reader()
            .map_err(|error| Refused(error.to_string()))
    }

    fn vault_id(&self) -> String {
        self.ctx.vault_id()
    }
}

fn refused(refusal: &Refusal) -> CoreError {
    CoreError::InvalidRequest {
        detail: refusal.to_string(),
    }
}

impl RoomHost for RoomRuntime {
    fn call(&self, ctx: &dyn RoomCtx, request: &wire::RoomRequest) -> Result<wire::RoomResponse> {
        use wire::room_request::Kind as K;
        let door = CtxDoor { ctx, runtime: self };
        let mut rooms = self.rooms.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(shown) = self.transition_vault(ctx, &mut rooms) {
            for effect in rooms.take_effects() {
                ctx.push_effect(effect);
            }
            if !matches!(&request.kind, Some(K::Open(_))) {
                return Ok(response(ctx, shown, Vec::new()));
            }
        }
        let shown = match &request.kind {
            Some(K::Open(open)) => {
                if !open.platform.is_empty() {
                    open.platform.clone_into(
                        &mut self.platform.lock().unwrap_or_else(PoisonError::into_inner),
                    );
                }
                if !open.time_zone.is_empty() {
                    centraid_vault::time::FireZone::named(&open.time_zone).map_err(|_| {
                        CoreError::InvalidRequest {
                            detail: "The phone's time zone is not recognized.".to_owned(),
                        }
                    })?;
                    *self
                        .time_zone
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(open.time_zone.clone());
                }
                let tab = if open.tab.is_empty() {
                    DEFAULT_TAB
                } else {
                    &open.tab
                };
                vec![
                    rooms
                        .open(&door, &open.key, tab, open.root)
                        .map_err(|r| refused(&r))?,
                ]
            }
            Some(K::Send(send)) => {
                let event = send.event.clone().unwrap_or_default();
                rooms
                    .event(&door, send.instance, &event)
                    .map_err(|r| refused(&r))?
                    .into_iter()
                    .collect()
            }
            Some(K::Lifecycle(lifecycle)) => {
                match wire::room_lifecycle::Phase::try_from(lifecycle.phase).ok() {
                    Some(wire::room_lifecycle::Phase::Background) => {
                        ctx.locker_lock()?;
                        rooms.lock_locker(&door)
                    }
                    Some(wire::room_lifecycle::Phase::Foreground) => rooms.foreground(&door),
                    _ => Vec::new(),
                }
            }
            None => {
                return Err(CoreError::InvalidRequest {
                    detail: "a room request names open or send".to_owned(),
                });
            }
        };
        let effects = rooms.take_effects();
        if effects.iter().any(|effect| {
            effect.kind.as_ref().is_some_and(
                |kind| matches!(kind, wire::shell_effect::Kind::OwnerCheck(check) if check.cancel),
            )
        }) {
            ctx.locker_cancel_check();
        }
        Ok(response(ctx, shown, effects))
    }

    fn changed(&self, ctx: &dyn RoomCtx, tables: &[String]) {
        let door = CtxDoor { ctx, runtime: self };
        let (shown, effects) = {
            let mut rooms = self.rooms.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(shown) = self.transition_vault(ctx, &mut rooms) {
                (shown, rooms.take_effects())
            } else {
                let shown = rooms.changed(&door, tables.iter().map(String::as_str));
                (shown, Vec::new())
            }
        };
        for effect in effects {
            ctx.push_effect(effect);
        }
        for each in shown {
            let mut shown = each.wire();
            shown.secure_epoch = ctx.locker_epoch();
            ctx.push(shown);
        }
    }
}

fn response(
    ctx: &dyn RoomCtx,
    shown: Vec<super::rooms::Shown>,
    effects: Vec<wire::ShellEffect>,
) -> wire::RoomResponse {
    let secure_epoch = ctx.locker_epoch();
    wire::RoomResponse {
        shown: shown
            .iter()
            .map(|entry| {
                let mut shown = entry.wire();
                shown.secure_epoch = secure_epoch;
                shown
            })
            .collect(),
        effects,
        secure_epoch,
    }
}
