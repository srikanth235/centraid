//! One notification receipt, kept through the existing device-only SecretBatch door.
//! Only its identity, history cursor and original deadline persist; words are read again.

use centraid_api_proto::core_v1 as wire;
use serde_json::{Value, json};

use super::desired::{RECEIPT, THREAD};
use crate::catalog::{act, load};
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{agenda_notify as words, task as task_words};

pub const KEY: &str = "notification-receipt";
pub const LIFETIME_MS: i64 = 600_000;
const MAX_BYTES: usize = 4_096;
/// The existing earlier-versions query's single-page ceiling; never chase another page.
const HISTORY_LIMIT: u32 = 100;

/// Required current/history facts could not be read; retain the accepted gesture for retry.
#[derive(Clone, Copy, Debug)]
pub struct ReadFailed;

#[derive(Clone, Debug)]
pub struct Metadata {
    pub id: String,
    pub vault: String,
    pub task: String,
    pub verb: i32,
    pub created: i64,
    pub expires: i64,
    pub seq: Option<i64>,
    pub undo_key: String,
    pub undo_requested_at: Option<i64>,
}

impl Metadata {
    pub fn encode(&self) -> Option<Vec<u8>> {
        let bytes = json!({"v":1,"id":self.id,"vault":self.vault,"task":self.task,
            "verb":self.verb,"created":self.created,"expires":self.expires,
            "seq":self.seq,"undo_key":self.undo_key,"undo_requested_at":self.undo_requested_at})
        .to_string()
        .into_bytes();
        (bytes.len() <= MAX_BYTES).then_some(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() > MAX_BYTES {
            return None;
        }
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let map = value.as_object()?;
        if map.len() != 10
            || value["v"].as_i64()? != 1
            || [
                "v",
                "id",
                "vault",
                "task",
                "verb",
                "created",
                "expires",
                "seq",
                "undo_key",
                "undo_requested_at",
            ]
            .iter()
            .any(|key| !map.contains_key(*key))
        {
            return None;
        }
        let text = |key: &str, max: usize| {
            let value = value[key].as_str()?;
            (value.len() <= max).then(|| value.to_owned())
        };
        let meta = Self {
            id: text("id", 256)?,
            vault: text("vault", 128)?,
            task: text("task", 128)?,
            verb: i32::try_from(value["verb"].as_i64()?).ok()?,
            created: value["created"].as_i64()?,
            expires: value["expires"].as_i64()?,
            seq: if value["seq"].is_null() {
                None
            } else {
                Some(value["seq"].as_i64()?)
            },
            undo_key: text("undo_key", 256)?,
            undo_requested_at: if value["undo_requested_at"].is_null() {
                None
            } else {
                Some(value["undo_requested_at"].as_i64()?)
            },
        };
        let prefix = format!("receipt|{}|", meta.vault);
        let suffix = meta.id.strip_prefix(&prefix)?;
        if suffix.is_empty()
            || !suffix.bytes().all(|b| b.is_ascii_digit())
            || meta.task.is_empty()
            || meta.task.contains('|')
            || ![
                wire::NotificationVerb::Done as i32,
                wire::NotificationVerb::SnoozeHour as i32,
                wire::NotificationVerb::Tomorrow as i32,
            ]
            .contains(&meta.verb)
            || meta.created.checked_add(LIFETIME_MS) != Some(meta.expires)
            || meta.seq.is_some_and(|seq| seq <= 0)
            || meta.seq.is_some() == meta.undo_key.is_empty()
            || meta
                .undo_requested_at
                .is_some_and(|at| meta.seq.is_none() || at < meta.created || at >= meta.expires)
        {
            return None;
        }
        Some(meta)
    }

    pub fn live(&self, vault: &str, now: i64) -> bool {
        self.vault == vault && self.created <= now && now < self.expires
    }
}

#[derive(Clone, Debug)]
pub struct Receipt {
    pub notification: wire::PendingNotification,
    pub task_id: String,
    pub meta: Metadata,
}

impl Receipt {
    pub fn made(
        ctx: &Ctx,
        vault: &str,
        task: &str,
        title: &str,
        verb: i32,
        seq: Option<i64>,
    ) -> Option<Self> {
        let now = ctx.now_ms()?;
        let meta = Metadata {
            id: format!("receipt|{vault}|{}", kit_act::fresh()),
            vault: vault.to_owned(),
            task: task.to_owned(),
            verb,
            created: now,
            expires: now.checked_add(LIFETIME_MS)?,
            seq,
            undo_requested_at: None,
            undo_key: if seq.is_some() {
                kit_act::key(&["notify", "undo", task], kit_act::fresh())
            } else {
                String::new()
            },
        };
        Some(Self::worded(ctx, meta, title))
    }

    pub fn restored(ctx: &Ctx, meta: Metadata) -> Result<Option<Self>, ReadFailed> {
        match read::read(
            ctx,
            load::reminders::Task {
                task_id: meta.task.clone(),
            },
            |answer| match answer {
                wire::app_query_response::Answer::AgendaTask(detail) => Some(detail.task),
                _ => None,
            },
        ) {
            Reading::Data(Some(task)) => Ok(Some(Self::worded(ctx, meta, &task.title))),
            Reading::Data(None) => Ok(None),
            _ => Err(ReadFailed),
        }
    }

    fn worded(ctx: &Ctx, meta: Metadata, title: &str) -> Self {
        let locale = ctx.locale();
        let heading = match wire::NotificationVerb::try_from(meta.verb) {
            Ok(wire::NotificationVerb::SnoozeHour) => words::snoozed_hour(locale),
            Ok(wire::NotificationVerb::Tomorrow) => words::moved_tomorrow(locale),
            _ => task_words::task_done(locale),
        };
        Self {
            task_id: meta.task.clone(),
            notification: wire::PendingNotification {
                notification_id: meta.id.clone(),
                zone: ctx.zone().to_owned(),
                title: heading,
                body: if title.trim().is_empty() {
                    task_words::untitled(locale)
                } else {
                    title.to_owned()
                },
                category_id: if meta.seq.is_some() {
                    RECEIPT.to_owned()
                } else {
                    String::new()
                },
                thread_id: THREAD.to_owned(),
                immediate: true,
                ..Default::default()
            },
            meta,
        }
    }

    /// Persist acceptance before running the inverse. A restarted receiver retries the same
    /// gesture only within its original deadline, never as a fresh ten-minute offer.
    pub fn request_undo(&self, now: i64) -> Option<Self> {
        if self.meta.seq.is_none() || now < self.meta.created || now >= self.meta.expires {
            return None;
        }
        let mut receipt = self.clone();
        receipt.meta.undo_requested_at = Some(now);
        Some(receipt)
    }

    pub fn undo(&self, ctx: &Ctx) -> Result<Option<Settled>, ReadFailed> {
        let Some(seq) = self.meta.seq else {
            return Ok(None);
        };
        if !self.unchanged_fields(ctx, seq)? {
            return Ok(None);
        }
        // undo-exempt: the notification receipt owns this guarded history Undo.
        Ok(Some(kit_act::act(
            ctx,
            act::shell::UndoChange {
                earlier_version_id: self.task_id.clone(),
                seq: Some(seq),
            },
            &self.meta.undo_key,
        )))
    }

    /// A notification's old button must not reverse a later decision on the same fields,
    /// including done -> open -> done. Generic history Undo deliberately permits a state
    /// changed back for layered gestures; the one-shot notification has this stricter guard.
    /// One bounded page contains all newer changes only if it also contains our version.
    fn unchanged_fields(&self, ctx: &Ctx, seq: i64) -> Result<bool, ReadFailed> {
        let mut request: wire::LoadRequest = load::shell::EarlierVersions {
            entity_id: self.task_id.clone(),
        }
        .into();
        request.limit = HISTORY_LIMIT;
        let Reading::Data(page) = read::read(ctx, request, |answer| match answer {
            wire::app_query_response::Answer::EarlierVersions(page) => Some(page),
            _ => None,
        }) else {
            return Err(ReadFailed);
        };
        let Some(original) = page.versions.iter().find(|version| version.seq == seq) else {
            return Ok(false);
        };
        if original.field_changes.is_empty() {
            return Ok(false);
        }
        Ok(!page
            .versions
            .iter()
            .filter(|version| version.seq > seq)
            .any(|later| {
                later.field_changes.iter().any(|change| {
                    original
                        .field_changes
                        .iter()
                        .any(|own| own.field == change.field)
                })
            }))
    }
}

pub fn effect(op: wire::secret_op::Op, value: Vec<u8>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Secrets(wire::SecretBatch {
            ops: vec![wire::SecretOp {
                op: op as i32,
                store: wire::SecretStore::Device as i32,
                key: KEY.to_owned(),
                value,
            }],
        })),
    }
}
