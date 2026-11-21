//! A NEW EVENT'S DRAFT SURVIVES THE PROCESS (#1202, owner ruling 29).
//!
//! The event editor has an explicit Save (`editor`), so words typed into a new event were lost
//! when Android killed the backgrounded app. This is the draft that keeps them.
//!
//! ## Where it lives
//!
//! In the phone's DEVICE store (the `Secrets` effect both shells already perform), under one
//! fixed key, never in the vault. A draft is not an event until Save: a vault row would be filed,
//! shared and backed up before the member decided, and would show in every search. The device
//! store is private to this phone, sealed by the platform, never backed up and never synchronised.
//! One slot: a second unsaved new event replaces the first. The vault's id rides inside the value,
//! so a draft is never offered in another vault.
//!
//! ## Who writes what
//!
//! - The EDITOR keeps the [`Board`] (memory, shared by the runtime) current after every change,
//!   and clears it on Save and on a confirmed discard. It never emits a store effect: a screen
//!   that is popped has its effects dropped (`Runtime::leave`), and a vault switch pops it.
//! - THE SERVICE ([`Service`], registered as [`NAME`], one per runtime) owns the device key. It
//!   makes the store say what the board says: on the app going to the background (the moment
//!   before Android may kill it), on the editor's debounce, and when the board is cleared. It
//!   writes only when the two differ, and one write at a time.
//!
//! ## What a relaunch does
//!
//! The service reads the key once at start. A draft of the vault in front is put back on the board
//! and the editor is REOPENED with it (`OpenRoute`, the way a tapped notification opens its page),
//! because that is what the other editors do: Notes, Docs and People come back to what the member
//! was typing, nothing to confirm. A draft of another vault is deleted, never shown. A draft the
//! member discarded or saved is gone, so a second relaunch opens nothing.
//!
//! The restored editor measures "changed" against a fresh new event, not against the draft, so
//! leaving it still asks before discarding, and Save is armed as soon as the draft is whole.
//!
//! Only a NEW event has a draft. An edit of an existing event is not kept: its save must name the
//! revision it replaces (#1185), and a record that outlived the event's own changes would skip
//! that refusal.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use centraid_api_proto::core_v1 as wire;
use prost::Message;
use serde_json::{Value, json};
use wire::screen_event::Kind as E;

use crate::screen::{Ctx, Screen};

/// The service's route name.
pub const NAME: &str = "calendar.draft";
/// The device-store key: one fixed name, the vault inside the value.
pub const KEY: &str = "calendar-draft";
/// The editor route's `instance_key` for "open with the stored draft". An editor of a NEW event has
/// no other use for the field.
pub const RESTORE: &str = "draft";
/// The editor's debounce timer: how long after the last change the service is woken.
pub const DEBOUNCE_TIMER: &str = "draft";
/// How long the editor waits after the last change.
pub const DEBOUNCE: Duration = Duration::from_secs(1);
/// A store that refused is asked again after this long.
const RETRY: Duration = Duration::from_secs(10);
/// The retry timer's name.
const RETRY_TIMER: &str = "retry";
/// How many times the first read is asked again before the store is left alone.
const READ_ATTEMPTS: u32 = 3;
/// The biggest value kept. A draft past it is not stored; the member is still typing into it.
const MAX_BYTES: usize = 64 * 1024;

/// An unsaved new event, as the device store holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    /// The vault it was typed in.
    pub vault: String,
    /// The values the pickers bound.
    pub draft: wire::AgendaDraft,
    /// A place typed that the vault does not hold yet (outside the draft).
    pub typed_place: String,
}

impl Stored {
    /// The text the store keeps, or `None` past [`MAX_BYTES`].
    #[must_use]
    pub fn encode(&self) -> Option<String> {
        let draft = base64::engine::general_purpose::STANDARD.encode(self.draft.encode_to_vec());
        let text = json!({
            "v": 1,
            "vault": self.vault,
            "typed_place": self.typed_place,
            "draft": draft,
        })
        .to_string();
        (text.len() <= MAX_BYTES).then_some(text)
    }

    /// What `text` holds, or `None` for anything that is not a draft this build wrote.
    #[must_use]
    pub fn decode(text: &[u8]) -> Option<Self> {
        if text.len() > MAX_BYTES {
            return None;
        }
        let value: Value = serde_json::from_slice(text).ok()?;
        if value["v"].as_i64()? != 1 {
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(value["draft"].as_str()?)
            .ok()?;
        Some(Self {
            vault: value["vault"].as_str()?.to_owned(),
            typed_place: value["typed_place"].as_str()?.to_owned(),
            draft: wire::AgendaDraft::decode(bytes.as_slice()).ok()?,
        })
    }
}

/// The draft as the runtime holds it in memory: what the editor says and the service persists.
/// Cheap to clone; every clone is the one board.
#[derive(Clone, Debug, Default)]
pub struct Board(Arc<Mutex<Option<Stored>>>);

impl Board {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Stored>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The draft, if there is one.
    #[must_use]
    pub fn get(&self) -> Option<Stored> {
        self.lock().clone()
    }

    /// Whether `draft` differs from what the board holds, and hold it.
    pub fn set(&self, draft: Stored) -> bool {
        let mut held = self.lock();
        let changed = held.as_ref() != Some(&draft);
        *held = Some(draft);
        changed
    }

    /// Drop the draft; whether there was one.
    pub fn clear(&self) -> bool {
        self.lock().take().is_some()
    }
}

/// The vault in front: its id, `None` before the shelf has mounted one, and the empty id on a host
/// with no shelf.
#[must_use]
pub fn vault_in_front(ctx: &Ctx) -> Option<String> {
    match ctx.vaults() {
        Some(vaults) => vaults.foreground_id(),
        None => Some(String::new()),
    }
}

/// Tell the service the board changed.
pub fn wake(ctx: &Ctx) {
    ctx.post(
        NAME,
        wire::ScreenEvent {
            kind: Some(E::Signalled(wire::Signalled {})),
        },
    );
}

/// The route that opens the editor with the stored draft.
#[must_use]
pub fn restore_route() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: super::EDITOR.to_owned(),
        args: Some(wire::route::Args::AgendaEditor(wire::AgendaEditorRoute {
            instance_key: RESTORE.to_owned(),
            kind: wire::AgendaEditorKind::Event as i32,
            ..wire::AgendaEditorRoute::default()
        })),
    }
}

/// The route that opens the service.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: NAME.to_owned(),
        args: None,
    }
}

/// The services Calendar runs for as long as the runtime does.
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![route()]
}

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Service::default()))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    /// The key has not been asked for.
    #[default]
    Unread,
    /// The read is out.
    Reading,
    /// The store's content is known.
    Ready,
}

#[derive(Default)]
struct Service {
    phase: Phase,
    /// How many reads the store has refused.
    refused: u32,
    /// What the device store holds, as last known.
    held: Option<String>,
    /// The write in flight, and what it says.
    inflight: Option<Option<String>>,
    /// What the store held at start, until the vault in front is known.
    startup: Option<Stored>,
}

fn effect(op: wire::secret_op::Op, value: Vec<u8>) -> wire::Effect {
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

impl Service {
    fn advance(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        match self.phase {
            Phase::Unread => {
                self.phase = Phase::Reading;
                out.push(effect(wire::secret_op::Op::Get, Vec::new()));
                return;
            }
            Phase::Reading => return,
            Phase::Ready => {}
        }
        let board = ctx.drafts();
        if let Some(front) = vault_in_front(ctx) {
            if let Some(stored) = self.startup.take() {
                // A draft of the vault in front comes back, unless the member already began
                // another; a draft of any other vault is not this vault's to show (the board stays
                // empty, so the store is cleared below).
                if stored.vault == front && board.get().is_none() {
                    board.set(stored);
                    out.push(wire::Effect {
                        kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                            route: Some(restore_route()),
                        })),
                    });
                }
            }
            // A VAULT SWITCH ENDS THE DRAFT: it was typed in a vault that is no longer in front.
            if board.get().is_some_and(|stored| stored.vault != front) {
                board.clear();
            }
        }
        if self.startup.is_some() || self.inflight.is_some() {
            return;
        }
        let want = board.get().and_then(|stored| stored.encode());
        if want == self.held {
            return;
        }
        let (op, value) = match &want {
            Some(text) => (wire::secret_op::Op::Set, text.clone().into_bytes()),
            None => (wire::secret_op::Op::Delete, Vec::new()),
        };
        self.inflight = Some(want);
        out.push(effect(op, value));
    }

    fn answered(&mut self, answer: &wire::SecretBatched, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        let result = (answer.answers.len() == 1)
            .then(|| &answer.answers[0])
            .filter(|answer| answer.ok);
        match self.phase {
            Phase::Reading => {
                let Some(result) = result else {
                    self.refused += 1;
                    if self.refused < READ_ATTEMPTS {
                        self.phase = Phase::Unread;
                        ctx.start_timer(RETRY_TIMER, RETRY);
                    } else {
                        self.phase = Phase::Ready;
                    }
                    return;
                };
                self.phase = Phase::Ready;
                if result.found {
                    self.held = Some(String::from_utf8_lossy(&result.value).into_owned());
                    // What is not a draft this build wrote is cleared with the rest.
                    self.startup = Stored::decode(&result.value);
                }
            }
            Phase::Ready => {
                let Some(sent) = self.inflight.take() else {
                    return;
                };
                if result.is_some() {
                    self.held = sent;
                } else {
                    ctx.start_timer(RETRY_TIMER, RETRY);
                    return;
                }
            }
            Phase::Unread => return,
        }
        self.advance(ctx, out);
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut out = Vec::new();
        match event.kind {
            Some(
                E::Appeared(_)
                | E::DataChanged(_)
                | E::ScreenOpened(_)
                | E::Signalled(_)
                | E::Lifecycle(_),
            ) => self.advance(ctx, &mut out),
            Some(E::TimerFired(fired)) if fired.timer == RETRY_TIMER => {
                self.advance(ctx, &mut out);
            }
            Some(E::EffectResult(result)) => match result.outcome {
                Some(wire::effect_result::Outcome::Secrets(answer)) => {
                    self.answered(&answer, ctx, &mut out);
                }
                Some(wire::effect_result::Outcome::Failed(_)) => {
                    self.answered(&wire::SecretBatched::default(), ctx, &mut out);
                }
                _ => {}
            },
            _ => {}
        }
        out
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored() -> Stored {
        Stored {
            vault: "v1".to_owned(),
            draft: wire::AgendaDraft {
                title: "Dentist".to_owned(),
                start_day: "2026-12-01".to_owned(),
                ..wire::AgendaDraft::default()
            },
            typed_place: "Clinic".to_owned(),
        }
    }

    #[test]
    fn a_draft_reads_back_as_it_was_written() {
        let text = stored().encode().expect("a small draft is kept");
        assert_eq!(Stored::decode(text.as_bytes()), Some(stored()));
    }

    #[test]
    fn what_is_not_a_draft_is_none() {
        assert_eq!(Stored::decode(b"not json"), None);
        assert_eq!(Stored::decode(br#"{"v":2}"#), None);
        assert_eq!(Stored::decode(b""), None);
    }

    #[test]
    fn a_draft_past_the_limit_is_not_kept() {
        let mut big = stored();
        big.draft.notes = "x".repeat(MAX_BYTES);
        assert_eq!(big.encode(), None);
    }

    #[test]
    fn the_board_says_whether_it_changed() {
        let board = Board::default();
        assert!(board.set(stored()));
        assert!(!board.set(stored()));
        assert!(board.clear());
        assert!(!board.clear());
    }
}
