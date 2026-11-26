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

pub struct RoomRuntime {
    rooms: Mutex<Rooms>,
    keys: AtomicU64,
    last: Mutex<Option<(Act, serde_json::Value)>>,
}

impl RoomRuntime {
    #[must_use]
    pub fn new(registry: Registry) -> Self {
        Self {
            rooms: Mutex::new(Rooms::new(registry)),
            keys: AtomicU64::new(1),
            last: Mutex::new(None),
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

impl CtxDoor<'_> {
    fn key(&self) -> String {
        format!(
            "room:{}:{}",
            self.ctx.now_ms(),
            self.runtime.keys.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn run(
        &self,
        decl: &ActionDecl,
        input: &serde_json::Value,
    ) -> std::result::Result<(), Refused> {
        match self.ctx.command(decl.command, input, &self.key()) {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Ok(()),
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
    fn act(&self, act: &Act) -> std::result::Result<Done, Refused> {
        let decl = decl_of(&act.name).ok_or_else(|| Refused(words::act_refused(Locale::En)))?;
        self.run(decl, &act.input)?;
        let paired = matches!(decl.inverse, Inverse::Pair(_));
        *self
            .runtime
            .last
            .lock()
            .unwrap_or_else(PoisonError::into_inner) =
            paired.then(|| (act.clone(), act.input.clone()));
        let sentence = match decl.verb {
            "trash" => words::act_trashed(Locale::En),
            "restore" => words::act_restored(Locale::En),
            _ => words::act_done(Locale::En),
        };
        Ok(Done {
            sentence,
            undo: paired,
        })
    }

    fn undo(&self) -> std::result::Result<Done, Refused> {
        let last = self
            .runtime
            .last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some((act, input)) = last else {
            return Err(Refused(words::act_refused(Locale::En)));
        };
        let inverse = decl_of(&act.name)
            .and_then(|decl| match decl.inverse {
                Inverse::Pair(name) => decl_of(name),
                _ => None,
            })
            .ok_or_else(|| Refused(words::act_refused(Locale::En)))?;
        self.run(inverse, &input)?;
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
