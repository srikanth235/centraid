//! THE ROOM RUNTIME ON A CORE (app-plane §1): the one object the core's `RoomHost` door is. It
//! holds the stacks of rooms behind a lock and, for each call, a door over the core's own
//! context, through which a tap runs a catalogue action and a room reads the backup status.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

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
    platform: Mutex<String>,
}

impl RoomRuntime {
    #[must_use]
    pub fn new(registry: Registry) -> Self {
        Self {
            rooms: Mutex::new(Rooms::new(registry)),
            keys: AtomicU64::new(1),
            last: Mutex::new(None),
            platform: Mutex::new(String::new()),
        }
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
                for (id, seq) in pairs.into_iter().rev() {
                    self.run_command(
                        "history.restore_version",
                        &serde_json::json!({ "id": id, "seq": seq }),
                    )?;
                }
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
        let shown = match &request.kind {
            Some(K::Open(open)) => {
                if !open.platform.is_empty() {
                    open.platform.clone_into(
                        &mut self.platform.lock().unwrap_or_else(PoisonError::into_inner),
                    );
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
            None => {
                return Err(CoreError::InvalidRequest {
                    detail: "a room request names open or send".to_owned(),
                });
            }
        };
        Ok(wire::RoomResponse {
            shown: shown.iter().map(super::rooms::Shown::wire).collect(),
            effects: rooms.take_effects(),
        })
    }

    fn changed(&self, ctx: &dyn RoomCtx, tables: &[String]) {
        let door = CtxDoor { ctx, runtime: self };
        let shown = {
            let mut rooms = self.rooms.lock().unwrap_or_else(PoisonError::into_inner);
            rooms.changed(&door, tables.iter().map(String::as_str))
        };
        for each in shown {
            ctx.push(each.wire());
        }
    }
}
