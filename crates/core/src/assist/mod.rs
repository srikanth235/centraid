//! THE CHAT'S DOOR INTO THE CORE: sessions in memory, turns run on the caller's
//! thread, events onto the queue the shell already drains.
//!
//! `crates/assist` is the plane — registry, prompt, grammar, turn loop — and
//! holds no vault and no engine. This module is what joins it to a [`Handle`]:
//!
//! * [`reads`] runs each registered tool through the query path a screen uses;
//! * [`attach`] turns an asset id, a document id or picked bytes into what the
//!   plane reads over a question, and refuses what the chat does not read;
//! * [`Hub`] holds the sessions and the model slot;
//! * [`answer`] is `Request::Assist`'s arm.
//!
//! # A TURN RUNS ON THE CALLING THREAD, AND NOTHING HOLDS THE VAULT WHILE THE
//! # MODEL THINKS
//!
//! `Handle::call` is synchronous and the shell never makes it from a UI
//! thread, so a turn needs no thread of its own: it runs where the call
//! arrived and pushes [`wire::AssistEvent`]s onto the event queue as it goes.
//! The vault lock is taken only inside a read ([`VaultReader`]), for as long as
//! one bounded query takes — a generation that lasts seconds holds nothing a
//! tile needs, so the rest of the app keeps reading while the model works.
//!
//! # ONE TURN AT A TIME PER SESSION, AND STOP IS ITS OWN CALL
//!
//! A second send on a running session answers `BUSY` rather than queueing.
//! `AssistCancel` is made from another thread (calls are reentrant) and sets a
//! flag the engine polls; the running send then answers `CANCELLED`.
//!
//! # A SESSION IS MEMORY; WHAT WAS SAID IS THE VAULT'S (R-CHAT-1)
//!
//! A session is a `Mutex<Session>` in a map: the model's view of a chat, the
//! last two turns. Dropping the handle drops every session. What the member said
//! and was told is saved at the end of each turn through the `chat.save_turn`
//! command ([`store`]) and read back by the `chat.*` app queries, so a chat is
//! backed up with the vault, deletable, and per vault — and a stored thread
//! reopens into a fresh session whose follow-ups route as they would have.
//! Which thread a session saves into is the [`Slot`]'s: none until its first
//! turn is saved, and none again after a new chat.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_assist::prompt::Budget;
use centraid_assist::suggest::suggest;
use centraid_assist::turn::Event as TurnEvent;
use centraid_assist::{
    Answered, App, Cancel, Card, ModelHost, ModelState, Notice, Plane, ReadContext, ReadError,
    Reader, Reading, Refusal, Session, ToolCall, ToolOutput, VisionState, VisionStatus,
};

use crate::error::{CoreError, Result};
use crate::handle::Handle;

pub mod attach;
pub mod door;
pub mod reads;
pub mod store;

/// How many chats a handle keeps. A shell opens a chat per screen it was
/// opened from; past this the oldest idle one is forgotten.
const MAX_SESSIONS: usize = 8;

/// How long a stalled event consumer may hold a turn up before an event is
/// dropped. The response carries the final state, so a dropped token costs a
/// flicker and a blocked turn costs the whole chat.
const EVENT_PATIENCE: Duration = Duration::from_secs(3);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Slot {
    session: Mutex<Session>,
    cancel: Cancel,
    running: AtomicBool,
    /// The stored thread this chat saves into: `None` until its first turn is
    /// saved, and `None` again after a new chat.
    thread: Mutex<Option<String>>,
    /// What the last turn attached, as the vault keeps it, for a retry that
    /// carries none of its own.
    last_attachments: Mutex<Vec<store::AttachmentRef>>,
    /// Whether the last turn reached the vault. A retry replaces the last
    /// STORED turn, so one that never was must not delete an earlier one.
    last_saved: AtomicBool,
}

/// Clears a session's running flag however the turn ends, a panic included.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Sessions {
    last: u64,
    slots: BTreeMap<u64, Arc<Slot>>,
}

/// A handle's chats and its view of the model slot.
pub struct Hub {
    host: Mutex<Arc<ModelHost>>,
    sessions: Mutex<Sessions>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    /// A hub over a model slot of its own, which holds no model and no loader.
    #[must_use]
    pub fn new() -> Self {
        Self {
            host: Mutex::new(Arc::new(ModelHost::new())),
            sessions: Mutex::new(Sessions::default()),
        }
    }

    /// Share a model slot between handles. A phone holds several vaults and one
    /// model, so the shell's open path hands every handle the same host.
    pub fn use_host(&self, host: Arc<ModelHost>) {
        *locked(&self.host) = host;
    }

    /// The model slot.
    #[must_use]
    pub fn host(&self) -> Arc<ModelHost> {
        Arc::clone(&locked(&self.host))
    }

    fn start(&self, scope: Option<App>) -> u64 {
        self.start_with(Session::new(scope), None)
    }

    /// A session of its own, saving into `thread` when it has one.
    fn start_with(&self, session: Session, thread: Option<String>) -> u64 {
        let mut sessions = locked(&self.sessions);
        sessions.last += 1;
        let id = sessions.last;
        sessions.slots.insert(
            id,
            Arc::new(Slot {
                session: Mutex::new(session),
                cancel: Cancel::new(),
                running: AtomicBool::new(false),
                last_saved: AtomicBool::new(thread.is_some()),
                thread: Mutex::new(thread),
                last_attachments: Mutex::new(Vec::new()),
            }),
        );
        while sessions.slots.len() > MAX_SESSIONS {
            let idle = sessions
                .slots
                .iter()
                .find(|(_, slot)| !slot.running.load(Ordering::SeqCst))
                .map(|(id, _)| *id);
            match idle {
                Some(oldest) => sessions.slots.remove(&oldest),
                None => break,
            };
        }
        id
    }

    fn slot(&self, id: u64) -> Option<Arc<Slot>> {
        locked(&self.sessions).slots.get(&id).cloned()
    }
}

impl Handle {
    /// The chat's sessions and model slot. A shell hands every handle the same
    /// [`ModelHost`] through [`Hub::use_host`], so one model serves every vault.
    #[must_use]
    pub const fn assist(&self) -> &Hub {
        &self.assist
    }
}

fn invalid(detail: impl Into<String>) -> CoreError {
    CoreError::InvalidRequest {
        detail: detail.into(),
    }
}

/// The app a request names: empty is every app, and anything the assistant
/// does not read — Locker included — is the request's fault.
fn scope_of(app: &str) -> Result<Option<App>> {
    if app.is_empty() {
        return Ok(None);
    }
    App::from_id(app)
        .map(Some)
        .ok_or_else(|| invalid(format!("`{app}` is not an app the assistant reads")))
}

// ---------------------------------------------------------------------------
// The vault, as a Reader.
// ---------------------------------------------------------------------------

/// [`Reader`] over a handle's vault. The lock is held for one read.
pub struct VaultReader<'a> {
    pub handle: &'a Handle,
}

impl Reader for VaultReader<'_> {
    fn read(
        &self,
        call: &ToolCall,
        context: &ReadContext<'_>,
    ) -> std::result::Result<ToolOutput, ReadError> {
        self.handle
            .with_vault(|vault| Ok(reads::run(vault, call, context.tz)))
            .map_err(|error| ReadError(error.to_string()))?
    }
}

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

fn card_to_wire(card: &Card) -> wire::AssistCard {
    wire::AssistCard {
        app: card.app.id().to_owned(),
        entity: card.entity.to_owned(),
        id: card.id.clone(),
        qualifier: card.qualifier.clone(),
        title: card.title.clone(),
        subtitle: card.subtitle.clone(),
        meta: card.meta.clone(),
    }
}

fn notices_to_wire(notices: &[Notice]) -> Vec<i32> {
    notices
        .iter()
        .map(|notice| match notice {
            Notice::DocTruncated => wire::AssistNotice::DocTruncated as i32,
        })
        .collect()
}

fn answer_to_wire(answered: &Answered) -> wire::AssistAnswer {
    wire::AssistAnswer {
        text: answered.text.clone(),
        cards: answered.cards.iter().map(card_to_wire).collect(),
        notices: notices_to_wire(&answered.notices),
    }
}

fn refusal_to_wire(refusal: &Refusal) -> wire::AssistRefusal {
    use wire::AssistRefusalReason as R;
    let (reason, detail) = match refusal {
        Refusal::NoToolFits => (R::NoToolFits, String::new()),
        Refusal::QueryFailed(detail) => (R::QueryFailed, detail.clone()),
        Refusal::Unparsable(detail) => (R::Unparsable, detail.clone()),
        Refusal::Cancelled => (R::Cancelled, String::new()),
        Refusal::ModelAbsent => (R::ModelAbsent, String::new()),
        Refusal::ModelFailed(detail) => (R::ModelFailed, detail.clone()),
        Refusal::Busy => (R::Busy, String::new()),
        Refusal::VisionAbsent => (R::VisionAbsent, String::new()),
        Refusal::AttachmentUnsupported => (R::AttachmentUnsupported, String::new()),
        Refusal::AttachmentUnreadable => (R::AttachmentUnreadable, String::new()),
        Refusal::AttachmentTooLarge => (R::AttachmentTooLarge, String::new()),
    };
    wire::AssistRefusal {
        reason: reason as i32,
        detail,
    }
}

fn event_to_wire(event: &TurnEvent) -> wire::assist_event::Kind {
    use wire::assist_event::Kind as K;
    match event {
        TurnEvent::Activity { app, tool } => K::Activity(wire::AssistActivity {
            app: app.id().to_owned(),
            tool: (*tool).to_owned(),
        }),
        TurnEvent::Cards(cards) => K::Cards(wire::AssistCards {
            cards: cards.iter().map(card_to_wire).collect(),
        }),
        TurnEvent::Reading(reading) => K::Reading(wire::AssistReading {
            kind: match reading {
                Reading::Photo => wire::AssistReadingKind::Photo,
                Reading::Document => wire::AssistReadingKind::Document,
            } as i32,
        }),
        TurnEvent::Token(text) => K::Token(wire::AssistToken { text: text.clone() }),
        TurnEvent::Answer {
            text,
            cards,
            notices,
        } => K::Answer(wire::AssistAnswer {
            text: text.clone(),
            cards: cards.iter().map(card_to_wire).collect(),
            notices: notices_to_wire(notices),
        }),
        TurnEvent::Failed(refusal) => K::Failed(refusal_to_wire(refusal)),
    }
}

fn state_to_wire(state: ModelState) -> wire::AssistModelState {
    match state {
        ModelState::Absent => wire::AssistModelState::Absent,
        ModelState::NoEngine => wire::AssistModelState::NoEngine,
        ModelState::Present => wire::AssistModelState::Present,
        ModelState::Loading => wire::AssistModelState::Loading,
        ModelState::Ready => wire::AssistModelState::Ready,
    }
}

fn vision_to_wire(state: VisionState) -> wire::AssistVisionState {
    match state {
        VisionState::Absent => wire::AssistVisionState::Absent,
        VisionState::Present => wire::AssistVisionState::Present,
        VisionState::Ready => wire::AssistVisionState::Ready,
    }
}

/// The status answer. `vision` is `None` when the request named no projector,
/// and the answer then leaves that field unspecified.
fn status_to_wire(
    status: centraid_assist::ModelStatus,
    vision: Option<VisionStatus>,
) -> wire::AssistResponse {
    wire::AssistResponse {
        kind: Some(wire::assist_response::Kind::Status(wire::AssistStatus {
            state: state_to_wire(status.state) as i32,
            model_bytes: status.bytes,
            vision: vision.map_or(wire::AssistVisionState::Unspecified, |held| {
                vision_to_wire(held.state)
            }) as i32,
            projector_bytes: vision.map_or(0, |held| held.bytes),
        })),
    }
}

/// The projector's state, when the request named a path for one.
fn vision_of(host: &ModelHost, projector: &str) -> Option<VisionStatus> {
    (!projector.is_empty()).then(|| host.vision_status(std::path::Path::new(projector)))
}

fn response(kind: wire::assist_response::Kind) -> wire::AssistResponse {
    wire::AssistResponse { kind: Some(kind) }
}

/// Push one event, waiting a little for a full queue.
fn emit(handle: &Handle, session_id: u64, turn_id: u64, kind: wire::assist_event::Kind) {
    let event = wire::Event {
        kind: Some(wire::event::Kind::Assist(wire::AssistEvent {
            session_id,
            turn_id,
            kind: Some(kind),
        })),
    };
    let queue = handle.events();
    let started = Instant::now();
    while !queue.push(event.clone()) {
        if handle.is_closed() || started.elapsed() > EVENT_PATIENCE {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

// ---------------------------------------------------------------------------
// The arm.
// ---------------------------------------------------------------------------

/// Answer one `Request::Assist`.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a malformed request, an unknown session or
/// an app the assistant does not read.
pub fn answer(handle: &Handle, request: &wire::AssistRequest) -> Result<wire::AssistResponse> {
    use wire::assist_request::Kind as K;
    let Some(kind) = &request.kind else {
        return Err(invalid("an assist request names no kind"));
    };
    let hub = &handle.assist;
    match kind {
        K::Status(asked) => {
            let host = hub.host();
            Ok(status_to_wire(
                host.status(std::path::Path::new(&asked.model_path)),
                vision_of(&host, &asked.projector_path),
            ))
        }
        K::Load(asked) => {
            let host = hub.host();
            let status = host
                .load(std::path::Path::new(&asked.model_path))
                .map_err(|error| invalid(error.to_string()))?;
            // GIVE THE MODEL ITS EYES when a projector was named. A projector
            // that will not attach is not a failed load: the text model is
            // loaded, and the answer says the projector is not READY.
            if !asked.projector_path.is_empty()
                && let Err(error) = host.attach_vision(std::path::Path::new(&asked.projector_path))
            {
                tracing::warn!("the vision projector would not attach: {error}");
            }
            Ok(status_to_wire(
                status,
                vision_of(&host, &asked.projector_path),
            ))
        }
        K::Unload(_) => {
            let host = hub.host();
            host.unload();
            // Nothing says which file a shell means, so the answer is the state
            // of the slot: no model is loaded, and an empty path says so.
            Ok(status_to_wire(host.status(std::path::Path::new("")), None))
        }
        K::Start(asked) if !asked.thread_id.is_empty() => {
            // REOPEN A STORED CHAT: the session is rebuilt from its last turns,
            // its scope is the thread's own, and the turns that follow are
            // saved into the same thread.
            let reopened =
                store::reopen(handle, &asked.thread_id)?.ok_or_else(|| invalid("no such chat"))?;
            let session_id = hub.start_with(reopened.session, Some(asked.thread_id.clone()));
            Ok(response(wire::assist_response::Kind::Started(
                wire::AssistStarted {
                    session_id,
                    thread_id: asked.thread_id.clone(),
                    scope_app: reopened
                        .scope
                        .map_or_else(String::new, |app| app.id().to_owned()),
                },
            )))
        }
        K::Start(asked) => {
            let scope = scope_of(&asked.app)?;
            Ok(response(wire::assist_response::Kind::Started(
                wire::AssistStarted {
                    session_id: hub.start(scope),
                    thread_id: String::new(),
                    scope_app: asked.app.clone(),
                },
            )))
        }
        K::Send(asked) => send(handle, asked),
        K::Documents(asked) => {
            let limit = if asked.limit == 0 {
                50
            } else {
                asked.limit.min(200)
            };
            let listed =
                handle.with_vault(|vault| Ok(vault.attachable_documents(limit as usize)?))?;
            Ok(response(wire::assist_response::Kind::Documents(
                wire::AssistDocuments {
                    documents: listed
                        .into_iter()
                        .map(|document| wire::AssistDocument {
                            doc_id: document.document_id,
                            title: document.title,
                            media_type: document.media_type,
                            updated_at: document.updated_at,
                        })
                        .collect(),
                },
            )))
        }
        K::Cancel(asked) => {
            // A late cancel — a finished turn, a forgotten session — is a no-op.
            if let Some(slot) = hub.slot(asked.session_id) {
                slot.cancel.cancel();
            }
            Ok(response(wire::assist_response::Kind::Ack(
                wire::AssistAck {},
            )))
        }
        K::Clear(asked) => {
            let slot = hub
                .slot(asked.session_id)
                .ok_or_else(|| invalid("no such chat"))?;
            slot.cancel.cancel();
            // Waits for a running turn to stop: the lock is the turn's.
            locked(&slot.session).clear();
            // A NEW CHAT IS A NEW THREAD: the old one keeps what it holds.
            *locked(&slot.thread) = None;
            slot.last_saved.store(false, Ordering::SeqCst);
            locked(&slot.last_attachments).clear();
            slot.cancel.reset();
            Ok(response(wire::assist_response::Kind::Ack(
                wire::AssistAck {},
            )))
        }
        K::Suggest(asked) => {
            let scope = scope_of(&asked.app)?;
            let prompts = suggest(
                &VaultReader { handle },
                scope,
                &ReadContext { tz: &asked.tz },
            )
            .into_iter()
            .map(|suggestion| suggestion.text)
            .collect();
            Ok(response(wire::assist_response::Kind::Suggestions(
                wire::AssistSuggestions { prompts },
            )))
        }
    }
}

fn sent(
    session_id: u64,
    turn_id: u64,
    outcome: wire::assist_sent::Outcome,
    saved: Option<&store::Saved>,
) -> wire::AssistResponse {
    response(wire::assist_response::Kind::Sent(wire::AssistSent {
        session_id,
        turn_id,
        outcome: Some(outcome),
        thread_id: saved.map_or_else(String::new, |saved| saved.thread_id.clone()),
        thread_title: saved.map_or_else(String::new, |saved| saved.title.clone()),
    }))
}

fn refused(
    session_id: u64,
    turn_id: u64,
    refusal: &Refusal,
    saved: Option<&store::Saved>,
) -> wire::AssistResponse {
    sent(
        session_id,
        turn_id,
        wire::assist_sent::Outcome::Refused(refusal_to_wire(refusal)),
        saved,
    )
}

/// Refuse a turn before the plane ran: the event stream and the response both
/// say so, like every other way a turn ends.
fn refuse(
    handle: &Handle,
    session_id: u64,
    turn_id: u64,
    refusal: &Refusal,
    saved: Option<&store::Saved>,
) -> wire::AssistResponse {
    emit(
        handle,
        session_id,
        turn_id,
        wire::assist_event::Kind::Failed(refusal_to_wire(refusal)),
    );
    refused(session_id, turn_id, refusal, saved)
}

/// What the member was told when a turn ended without an answer: the words
/// that were drawn before it did, and the reason, or a stop.
fn said_of_refusal(refusal: &Refusal, streamed: String, cards: Vec<Card>) -> Option<store::Said> {
    if matches!(refusal, Refusal::Cancelled) {
        return Some(store::Said {
            outcome: "stopped",
            text: streamed,
            cards,
            ..store::Said::default()
        });
    }
    Some(store::Said {
        outcome: "refused",
        text: streamed,
        refusal: Some(store::refusal_word(refusal)?),
        cards,
        ..store::Said::default()
    })
}

fn send(handle: &Handle, asked: &wire::AssistSendRequest) -> Result<wire::AssistResponse> {
    let hub = &handle.assist;
    let (session_id, turn_id) = (asked.session_id, asked.turn_id);
    let slot = hub
        .slot(session_id)
        .ok_or_else(|| invalid("no such chat"))?;
    if !asked.regenerate && asked.text.trim().is_empty() {
        return Err(invalid("a message with no text"));
    }
    attach::validate(&asked.attachments)?;
    if slot.running.swap(true, Ordering::SeqCst) {
        // Not emitted as an event: the turn that is running owns the stream.
        return Ok(refused(session_id, turn_id, &Refusal::Busy, None));
    }
    let _running = Running(&slot.running);
    slot.cancel.reset();

    let mut session = locked(&slot.session);
    let text = if asked.regenerate {
        session
            .prepare_regenerate()
            .ok_or_else(|| invalid("there is no earlier question to ask again"))?
    } else {
        asked.text.clone()
    };
    let scope = session.scope();

    // SAVING THE TURN (R-CHAT-1). Every way a turn ends — an answer, a stop,
    // any refusal but "busy" — is saved as what the member was shown, in one
    // commit, through `chat.save_turn`. A save that fails loses the history of
    // this turn and nothing else: the answer is still on screen.
    let persist = |said: &store::Said,
                   record: Option<&centraid_assist::prompt::Turn>,
                   resolved: Option<&centraid_assist::Attachments>|
     -> Option<store::Saved> {
        let refs = if asked.attachments.is_empty() && asked.regenerate {
            locked(&slot.last_attachments).clone()
        } else {
            store::refs_of(&asked.attachments, resolved)
        };
        let thread = locked(&slot.thread).clone();
        let replace =
            asked.regenerate && thread.is_some() && slot.last_saved.load(Ordering::SeqCst);
        let key = format!("chat.save_turn:{session_id}:{turn_id}");
        let saved = store::save(
            handle,
            &store::Turned {
                key: &key,
                thread: thread.as_deref(),
                replace_last: replace,
                scope,
                question: text.trim(),
                attachments: &refs,
                said,
                record,
            },
        );
        *locked(&slot.last_attachments) = refs;
        slot.last_saved.store(saved.is_some(), Ordering::SeqCst);
        if let Some(saved) = &saved {
            *locked(&slot.thread) = Some(saved.thread_id.clone());
        }
        saved
    };
    let end_without_a_turn =
        |refusal: &Refusal, resolved: Option<&centraid_assist::Attachments>| {
            let saved = said_of_refusal(refusal, String::new(), Vec::new())
                .and_then(|said| persist(&said, None, resolved));
            refuse(handle, session_id, turn_id, refusal, saved.as_ref())
        };

    let Some(model) = hub.host().model() else {
        return Ok(end_without_a_turn(&Refusal::ModelAbsent, None));
    };

    // WHAT RIDES ON THE QUESTION. A regenerate carries its attachments again
    // (the shell kept them); with none, the last turn's own are asked again.
    let carried = if asked.attachments.is_empty() && asked.regenerate {
        session.last_attachments().cloned()
    } else if asked.attachments.is_empty() {
        None
    } else {
        // A photo needs a projector, and finding that out costs nothing: say so
        // before a photograph is decoded.
        if attach::carries_image(&asked.attachments) && !model.has_vision() {
            session.note_question(&text);
            return Ok(end_without_a_turn(&Refusal::VisionAbsent, None));
        }
        match attach::resolve(handle, &asked.attachments)? {
            Ok(resolved) => Some(resolved),
            Err(refusal) => {
                session.note_question(&text);
                return Ok(end_without_a_turn(&refusal, None));
            }
        }
    };

    let reader = VaultReader { handle };
    let plane = Plane {
        model: &*model,
        reader: &reader,
        budget: Budget::DEFAULT,
    };
    // WHAT WAS DRAWN, for a turn that ends before its answer: the words that
    // streamed and the cards that arrived, which a stop keeps on screen.
    let mut streamed = String::new();
    let mut cards_seen: Vec<Card> = Vec::new();
    let history_before = session.history().len();
    let outcome = plane.run_attached_turn(
        &mut session,
        &text,
        carried.as_ref(),
        &ReadContext { tz: &asked.tz },
        &slot.cancel,
        &mut |event| {
            match &event {
                TurnEvent::Token(piece) => streamed.push_str(piece),
                TurnEvent::Cards(cards) => cards_seen.clone_from(cards),
                _ => {}
            }
            emit(handle, session_id, turn_id, event_to_wire(&event));
        },
    );
    // The plane's own record of the turn, when it kept one: what lets a
    // reopened chat route a follow-up as this one would have been.
    let record = (session.history().len() == history_before + 1)
        .then(|| session.history().last().cloned())
        .flatten();
    Ok(match outcome {
        Ok(answered) => {
            let said = store::Said {
                outcome: "answered",
                text: answered.text.clone(),
                refusal: None,
                notice: store::notice_word(&answered.notices),
                cards: answered.cards.clone(),
            };
            let saved = persist(&said, record.as_ref(), carried.as_ref());
            sent(
                session_id,
                turn_id,
                wire::assist_sent::Outcome::Answered(answer_to_wire(&answered)),
                saved.as_ref(),
            )
        }
        Err(refusal) => {
            let saved = said_of_refusal(&refusal, streamed, cards_seen)
                .and_then(|said| persist(&said, record.as_ref(), carried.as_ref()));
            refused(session_id, turn_id, &refusal, saved.as_ref())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_refusal_has_its_own_wire_reason() {
        use wire::AssistRefusalReason as R;
        let cases = [
            (Refusal::NoToolFits, R::NoToolFits),
            (Refusal::QueryFailed("x".into()), R::QueryFailed),
            (Refusal::Unparsable("x".into()), R::Unparsable),
            (Refusal::Cancelled, R::Cancelled),
            (Refusal::ModelAbsent, R::ModelAbsent),
            (Refusal::ModelFailed("x".into()), R::ModelFailed),
            (Refusal::Busy, R::Busy),
            (Refusal::VisionAbsent, R::VisionAbsent),
            (Refusal::AttachmentUnsupported, R::AttachmentUnsupported),
            (Refusal::AttachmentUnreadable, R::AttachmentUnreadable),
            (Refusal::AttachmentTooLarge, R::AttachmentTooLarge),
        ];
        let mut seen = std::collections::BTreeSet::new();
        for (refusal, reason) in cases {
            assert_eq!(refusal_to_wire(&refusal).reason, reason as i32);
            assert!(seen.insert(reason as i32));
        }
    }

    #[test]
    fn locker_and_unknown_apps_are_the_requests_fault() {
        assert_eq!(scope_of("").unwrap(), None);
        assert_eq!(scope_of("tasks").unwrap(), Some(App::Tasks));
        assert!(matches!(
            scope_of("locker"),
            Err(CoreError::InvalidRequest { .. })
        ));
        assert!(matches!(
            scope_of("nope"),
            Err(CoreError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn a_hub_forgets_its_oldest_idle_chat_past_the_cap() {
        let hub = Hub::new();
        let first = hub.start(None);
        for _ in 0..MAX_SESSIONS {
            hub.start(None);
        }
        assert!(hub.slot(first).is_none());
        assert!(hub.slot(first + 1).is_some());
    }

    #[test]
    fn a_running_chat_is_not_the_one_forgotten() {
        let hub = Hub::new();
        let first = hub.start(None);
        hub.slot(first)
            .unwrap()
            .running
            .store(true, Ordering::SeqCst);
        for _ in 0..MAX_SESSIONS {
            hub.start(None);
        }
        assert!(hub.slot(first).is_some());
        assert!(hub.slot(first + 1).is_none());
    }
}
