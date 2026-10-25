//! A question, the turn that answers it, and the write it may propose.

use centraid_api_proto::core_v1 as wire;
use wire::assist_request::Kind as Ask;
use wire::chat_state::Phase;

use super::model::{
    Await, Chat, Fail, Msg, Pending, Proposal, Source, Stage, Step, effect,
};
use crate::kit::rows::{self, RowRef};
use crate::screen::Ctx;
use crate::strings::chat as words;

impl Chat {
    pub(super) fn asked_by_member(&mut self, text: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        let line = text.trim();
        if !self.ready() || self.running || line.is_empty() || self.vision_blocked() {
            return Vec::new();
        }
        self.ask(line, false, ctx)
    }

    /// A search's Ask row. The chat starts a fresh one when the open chat holds a thread (the
    /// question is about something else), scoped to the app that searched. With no model yet the
    /// chat shows its download step and the question waits for it; it is not queued behind a
    /// download the member never asked for, so a chat that cannot become ready drops it.
    pub(super) fn asked_on_behalf(
        &mut self,
        scope: &str,
        question: &str,
        ctx: &Ctx,
    ) -> Vec<wire::Effect> {
        let question = question.trim();
        if question.is_empty() {
            return Vec::new();
        }
        let mut effects = Vec::new();
        let wanted = super::scope_of(scope);
        // Opening on the asked scope: an untouched chat adopts it, a used one starts over so the
        // question is not asked inside an unrelated thread.
        let rescope = self.opened && (self.scope != wanted || !self.messages.is_empty());
        if rescope {
            if self.running && self.session != 0 {
                self.cancel_remote(ctx);
            }
            effects.extend(self.start_over(&wanted, ctx));
        } else if !self.opened {
            effects.extend(self.on_event(
                wire::chat_event::Kind::Opened(wire::chat_event::Opened {
                    app: wanted,
                    ..wire::chat_event::Opened::default()
                }),
                ctx,
            ));
        }
        if self.can_ask() {
            effects.extend(self.ask(question, false, ctx));
        } else if matches!(self.phase, Phase::Checking | Phase::Loading | Phase::Downloading) {
            self.waiting = Some(super::model::Waiting {
                question: question.to_owned(),
            });
        }
        effects
    }

    /// A chat with nothing in it, on `scope`.
    fn start_over(&mut self, scope: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        let threads = std::mem::take(&mut self.threads);
        let models_dir = std::mem::take(&mut self.models_dir);
        let vault_name = std::mem::take(&mut self.vault_name);
        let turn = self.turn + 1;
        *self = Self {
            opened: true,
            scope: scope.to_owned(),
            models_dir,
            vault_name,
            threads,
            now_ms: self.now_ms,
            turn,
            ..Self::default()
        };
        let effects = self.read_status(ctx);
        self.read_threads(ctx);
        effects
    }

    /// Append the user's line (unless regenerating) and an empty answer, and send.
    pub(super) fn ask(&mut self, line: &str, regenerate: bool, ctx: &Ctx) -> Vec<wire::Effect> {
        let turn = self.turn + 1;
        let user = self.next_id;
        let answer = if regenerate { user } else { user + 1 };
        // A retry asks the last turn's attachments again; a new question takes what waits in the
        // composer, and the composer empties.
        let carried = if regenerate {
            self.last_sent.clone()
        } else {
            self.pending.clone()
        };
        // A card still waiting is superseded by the new question: the core drops it too.
        for message in &mut self.messages {
            message.supersede(ctx);
        }
        if !regenerate {
            self.messages.push(Msg {
                id: user,
                user: true,
                text: line.to_owned(),
                attachments: carried.clone(),
                ..Msg::default()
            });
        }
        self.messages.push(Msg {
            id: answer,
            streaming: true,
            ..Msg::default()
        });
        self.next_id = answer + 1;
        self.suggestions.clear();
        self.running = true;
        self.turn = turn;
        // The status line says something from the first moment: the answer is never a bare mark.
        self.activity = words::thinking(ctx.locale());
        self.error = None;
        self.asked = Some(line.to_owned());
        if !regenerate {
            self.pending.clear();
        }
        self.last_sent = carried.clone();
        let request = Ask::Send(wire::AssistSendRequest {
            session_id: self.session,
            text: line.to_owned(),
            tz: ctx.zone().to_owned(),
            regenerate,
            turn_id: turn,
            attachments: carried
                .iter()
                .filter(|held| held.source != Source::Unavailable)
                .map(wired)
                .collect(),
        });
        self.call(ctx, Await::Send(turn), request);
        Vec::new()
    }

    pub(super) fn stopped(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.running {
            self.cancel_remote(ctx);
        }
        Vec::new()
    }

    /// Ask the last question again, in place of the last answer.
    pub(super) fn regenerated(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(line) = self.asked.clone() else {
            return Vec::new();
        };
        if !self.ready() || self.running {
            return Vec::new();
        }
        if self.messages.last().is_some_and(|last| !last.user) {
            self.messages.pop();
        }
        if !self.messages.last().is_some_and(|last| last.user) {
            return Vec::new();
        }
        // The user's line stays where it was; only the answer is replaced, and the core drops the
        // turn it recorded (`regenerate`).
        self.ask(&line, true, ctx)
    }

    pub(super) fn new_chat(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.clear_thread();
        if self.session != 0 {
            let _ = ctx.assist(&super::model::assist(Ask::Clear(wire::AssistClearRequest {
                session_id: self.session,
            })));
            self.suggest(ctx);
        }
        Vec::new()
    }

    /// THE SAME CHAT, WITH NOTHING IN IT: no thread, no messages, the drawer shut. The core's
    /// session is told to clear separately (it unbinds the stored thread there), and the turn id
    /// moves on so that whatever an abandoned turn still says is stale.
    pub(super) fn clear_thread(&mut self) {
        self.messages.clear();
        self.suggestions.clear();
        self.running = false;
        self.turn += 1;
        self.activity.clear();
        self.error = None;
        self.asked = None;
        self.pending.clear();
        self.last_sent.clear();
        self.thread_id.clear();
        self.thread_title.clear();
        self.drawer_open = false;
        self.search = super::model::Search::default();
        self.found = None;
        self.awaiting.retain(|w| !matches!(w, Await::Send(_)));
    }

    pub(super) fn copied(&self, message_id: u64) -> Vec<wire::Effect> {
        let text = self
            .messages
            .iter()
            .find(|message| message.id == message_id)
            .map(|message| message.text.clone())
            .unwrap_or_default();
        if text.is_empty() {
            return Vec::new();
        }
        vec![effect(wire::effect::Kind::ClipboardSet(wire::ClipboardSet {
            text,
            sensitive: false,
            clear_after_ms: 0,
        }))]
    }

    /// One streamed event. Only the running turn's are heard.
    pub(super) fn on_stream(&mut self, event: &wire::AssistEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::assist_event::Kind as K;
        if !self.running || event.session_id != self.session || event.turn_id != self.turn {
            return Vec::new();
        }
        let locale = ctx.locale();
        match &event.kind {
            Some(K::Activity(activity)) => {
                self.activity = words::looking(locale).replace("{app}", &app_name(&activity.app));
            }
            Some(K::Reading(reading)) => {
                self.activity = match wire::AssistReadingKind::try_from(reading.kind) {
                    Ok(wire::AssistReadingKind::Photo) => words::reading_photo(locale),
                    Ok(wire::AssistReadingKind::Document) => words::reading_document(locale),
                    _ => words::thinking(locale),
                };
            }
            Some(K::Cards(cards)) => {
                let cards: Vec<wire::ChatCard> = cards.cards.iter().map(card).collect();
                self.with_answer(|answer| answer.cards = cards);
            }
            Some(K::Token(token)) => {
                // The first words end "Thinking": text is its own status.
                if self.activity == words::thinking(locale) {
                    self.activity.clear();
                }
                self.with_answer(|answer| answer.text.push_str(&token.text));
            }
            Some(K::Pending(pending)) => {
                self.with_answer(|answer| answer.with_proposal(pending));
            }
            Some(K::Answer(answer)) => self.answered(answer),
            Some(K::Failed(failed)) => return self.failed(Some(failed), ctx),
            None => {}
        }
        Vec::new()
    }

    /// The `send` call came back: the same fact as the terminal event, and the ONE carrier of
    /// where the turn was saved.
    ///
    /// The thread is absorbed whichever of the two arrived first (an event can be dropped from a
    /// full queue and a response cannot), but only for the latest turn: a new chat moves the turn
    /// id on, and an old turn's thread must not be adopted by the chat that replaced it.
    pub(super) fn settled(
        &mut self,
        turn: u64,
        sent: Option<wire::AssistSent>,
        ctx: &Ctx,
    ) -> Vec<wire::Effect> {
        if turn != self.turn {
            return Vec::new();
        }
        let saved = sent.as_ref().is_some_and(|sent| !sent.thread_id.is_empty());
        if let Some(sent) = sent.as_ref().filter(|sent| !sent.thread_id.is_empty()) {
            self.thread_id.clone_from(&sent.thread_id);
            if !sent.thread_title.is_empty() {
                self.thread_title.clone_from(&sent.thread_title);
            }
        }
        let mut effects = Vec::new();
        if self.running {
            match sent.and_then(|sent| sent.outcome) {
                Some(wire::assist_sent::Outcome::Answered(answer)) => self.answered(&answer),
                Some(wire::assist_sent::Outcome::Refused(refusal)) => {
                    effects = self.failed(Some(&refusal), ctx);
                }
                None => effects = self.failed(None, ctx),
            }
        }
        if saved {
            self.read_threads(ctx);
        }
        effects
    }

    fn answered(&mut self, answer: &wire::AssistAnswer) {
        let truncated = answer
            .notices
            .contains(&(wire::AssistNotice::DocTruncated as i32));
        // The card rode the stream before the answer and rides the answer too, so one that was
        // dropped from a full queue still arrives; `with_proposal` keeps the one it has.
        self.with_answer(|message| {
            message.text.clone_from(&answer.text);
            message.cards = answer.cards.iter().map(card).collect();
            message.streaming = false;
            message.truncated = truncated;
            if let Some(pending) = &answer.pending {
                message.with_proposal(pending);
            }
        });
        self.running = false;
        self.activity.clear();
        self.error = None;
    }

    fn with_answer(&mut self, change: impl FnOnce(&mut Msg)) {
        if let Some(last) = self.messages.last_mut().filter(|last| !last.user) {
            change(last);
        }
    }

    /// The line a refusal is told in, or none for a stop, which says nothing.
    fn refusal_fail(reason: i32) -> Option<Fail> {
        use wire::AssistRefusalReason as R;
        match R::try_from(reason).unwrap_or(R::Unspecified) {
            R::Cancelled => None,
            R::NoToolFits => Some(Fail::NoTool),
            R::QueryFailed => Some(Fail::Read),
            R::ModelFailed => Some(Fail::Model),
            R::VisionAbsent => Some(Fail::Vision),
            R::AttachmentUnsupported => Some(Fail::AttachUnsupported),
            R::AttachmentUnreadable => Some(Fail::AttachUnreadable),
            R::AttachmentTooLarge => Some(Fail::AttachTooLarge),
            _ => Some(Fail::Generic),
        }
    }

    pub(super) fn stored_fail(reason: i32) -> Option<Fail> {
        Self::refusal_fail(reason)
    }

    /// A turn that did not answer. A stop keeps what was drawn and says nothing about it; any
    /// other failure keeps cards that were drawn and puts one line about it where the view reads
    /// `error`.
    fn failed(&mut self, refusal: Option<&wire::AssistRefusal>, ctx: &Ctx) -> Vec<wire::Effect> {
        let reason = refusal.map_or(wire::AssistRefusalReason::Unspecified as i32, |r| r.reason);
        let drawn = self.messages.last().is_some_and(|last| {
            !last.user && (!last.text.is_empty() || !last.cards.is_empty() || last.proposal.is_some())
        });
        match self.messages.last_mut() {
            Some(last) if !last.user && drawn => {
                // A turn that failed after parking a write does not offer it: the turn is over.
                last.supersede(ctx);
                last.streaming = false;
                last.stopped = true;
            }
            Some(last) if !last.user => {
                self.messages.pop();
            }
            _ => {}
        }
        self.running = false;
        self.activity.clear();
        self.error = Self::refusal_fail(reason);
        use wire::AssistRefusalReason as R;
        match R::try_from(reason).unwrap_or(R::Unspecified) {
            // THE PHOTO READER WENT AWAY (the model was unloaded, and its projector with it):
            // look again, so the composer says what to do about it.
            R::VisionAbsent => {
                self.vision = self.vision.unloaded();
                self.read_vision(ctx)
            }
            // THE MODEL WENT AWAY (memory pressure unloaded it): ask what stands now, so the chat
            // draws the load step instead of failing every question.
            R::ModelAbsent => {
                self.phase = Phase::Checking;
                self.error = None;
                self.vision = self.vision.unloaded();
                self.session = 0;
                self.read_status(ctx)
            }
            _ => Vec::new(),
        }
    }

    // ------------------------------------------------------------ proposals --

    fn proposal_mut(&mut self, id: &str, stage: Stage) -> Option<&mut Proposal> {
        self.messages
            .iter_mut()
            .filter_map(|message| message.proposal.as_mut())
            .find(|held| held.id == id && held.stage == stage)
    }

    /// Confirm was tapped. Only a card WAITING, on a settled turn, is run; the core runs it once.
    pub(super) fn confirm_tapped(&mut self, id: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.ready() || self.running || id.is_empty() {
            return Vec::new();
        }
        let Some(held) = self.proposal_mut(id, Stage::Waiting) else {
            return Vec::new();
        };
        held.stage = Stage::Working;
        self.error = None;
        self.run_confirm(id, ctx)
    }

    fn run_confirm(&mut self, id: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        let answer = ctx.assist(&super::model::assist(Ask::Confirm(wire::AssistConfirmRequest {
            session_id: self.session,
            pending_id: id.to_owned(),
        })));
        let settled = match answer.ok().and_then(|answer| answer.kind) {
            Some(wire::assist_response::Kind::Settled(settled)) => Some(settled),
            _ => None,
        };
        let locale = ctx.locale();
        // THE CALL ITSELF FAILED: nothing ran, so the card is offered again rather than claiming
        // an outcome nobody saw.
        let Some(settled) = settled else {
            if let Some(held) = self.proposal_mut(id, Stage::Working) {
                held.stage = Stage::Waiting;
            }
            self.error = Some(Fail::Generic);
            return Vec::new();
        };
        use wire::AssistSettleOutcome as O;
        let outcome = O::try_from(settled.outcome).unwrap_or(O::Unspecified);
        // A SECRET THE MEMBER TYPED IS SEALED ONLY WHILE LOCKER IS OPEN: nothing ran and the card
        // is still waiting in the core. It stays WORKING while the OS owner check opens Locker,
        // then the same confirm is sent again.
        if outcome == O::LockerLocked {
            self.unlocking = Some(id.to_owned());
            return vec![effect(wire::effect::Kind::OwnerCheck(wire::OwnerCheck {
                ask: true,
                reason: words::unlock_reason(locale),
                title: words::unlock_title(locale),
                subtitle: words::unlock_subtitle(locale),
            }))];
        }
        if let Some(held) = self.proposal_mut(id, Stage::Working) {
            held.stage = match outcome {
                O::Applied => Stage::Applied,
                O::Stale => Stage::Stale,
                // A refusal, a card that was already gone, anything this build has no name for.
                _ => Stage::NotDone,
            };
            held.line = if settled.line.is_empty() {
                words::not_done(locale)
            } else {
                settled.line
            };
        }
        Vec::new()
    }

    /// The OS owner check answered for a held confirm: opened, the same confirm goes again; not,
    /// the card is waiting as it was.
    pub(super) fn owner_checked(&mut self, checked: &wire::OwnerChecked, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(id) = self.unlocking.take() else {
            return Vec::new();
        };
        let passed = checked.outcome == wire::owner_checked::Outcome::Succeeded as i32;
        let opened = passed
            && ctx
                .locker(&wire::LockerSessionRequest {
                    step: Some(wire::locker_session_request::Step::Unlock(
                        wire::LockerUnlock {},
                    )),
                })
                .is_ok_and(|answer| answer.state == wire::LockerSessionState::Unlocked as i32);
        if !opened {
            if let Some(held) = self.proposal_mut(&id, Stage::Working) {
                held.stage = Stage::Waiting;
            }
            return Vec::new();
        }
        if self.proposal_mut(&id, Stage::Working).is_none() {
            return Vec::new();
        }
        let mut effects = self.run_confirm(&id, ctx);
        effects.push(effect(wire::effect::Kind::Announce(wire::Announce {
            topic: "locker.unlocked".to_owned(),
        })));
        effects
    }

    /// Cancel was tapped: the card settles at once ("Not done.") and the core is told. A core
    /// that does not hear it still holds a card nothing can tap, and the next message drops it.
    pub(super) fn cancel_tapped(&mut self, id: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.ready() || self.running || id.is_empty() {
            return Vec::new();
        }
        let line = words::not_done(ctx.locale());
        let Some(held) = self.proposal_mut(id, Stage::Waiting) else {
            return Vec::new();
        };
        held.stage = Stage::NotDone;
        held.line = line;
        let _ = ctx.assist(&super::model::assist(Ask::Dismiss(wire::AssistDismissRequest {
            session_id: self.session,
            pending_id: id.to_owned(),
        })));
        Vec::new()
    }

    // ----------------------------------------------------------------- cards --

    /// A card was tapped: the page its row lives on, unless the row is gone since the answer.
    pub(super) fn card_tapped(&mut self, message_id: u64, index: usize, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(tapped) = self
            .messages
            .iter()
            .find(|message| message.id == message_id)
            .and_then(|message| message.cards.get(index))
            .cloned()
        else {
            return Vec::new();
        };
        let row = RowRef {
            app: tapped.app.clone(),
            entity: tapped.entity.clone(),
            id: tapped.id.clone(),
            title: tapped.title.clone(),
            qualifier: tapped.qualifier.clone(),
        };
        // A conversation opens in the Chat tab: no page to push.
        if rows::is_thread(&row) {
            return self.thread_opened(&row.id, &row.title, ctx);
        }
        self.card_gone = !self.row_live(&row, ctx);
        if self.card_gone {
            return Vec::new();
        }
        let neighbours: Vec<String> = self
            .messages
            .iter()
            .find(|message| message.id == message_id)
            .map(|message| {
                message
                    .cards
                    .iter()
                    .filter(|card| card.app == "photos" && card.entity == "photo")
                    .map(|card| card.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        match rows::route_of(&row, &words::title(ctx.locale()), &neighbours) {
            Some(route) => vec![effect(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                route: Some(route),
            }))],
            None => Vec::new(),
        }
    }

    /// Whether the row a card names is still in the vault. True when the core would not say, and
    /// for a card that names no row (a member action, an export).
    fn row_live(&self, row: &RowRef, ctx: &Ctx) -> bool {
        if row.id.is_empty() || rows::MemberAction::parse(row).is_some() {
            return true;
        }
        let asked = crate::catalog::load::shell::ChatCard {
            app: row.app.clone(),
            entity: row.entity.clone(),
            id: row.id.clone(),
        };
        crate::kit::read::read(ctx, asked, |answer| match answer {
            wire::app_query_response::Answer::ChatCard(live) => Some(live.exists),
            _ => None,
        })
        .data()
        .copied()
        .unwrap_or(true)
    }

    pub(super) fn vision_blocked(&self) -> bool {
        self.pending.iter().any(|held| held.photo) && !self.vision.ready
    }
}

impl Msg {
    /// A card still WAITING when something newer happens goes inert; any other stage has already
    /// ended or is in flight.
    pub(super) fn supersede(&mut self, ctx: &Ctx) {
        if let Some(held) = self.proposal.as_mut().filter(|held| held.stage == Stage::Waiting) {
            held.stage = Stage::Inert;
            held.line = words::not_done(ctx.locale());
        }
    }

    /// The card the core sent, once: the stream and the answer both carry it, in either order.
    fn with_proposal(&mut self, parked: &wire::AssistPending) {
        if parked.pending_id.is_empty()
            || self.proposal.as_ref().is_some_and(|held| held.id == parked.pending_id)
        {
            return;
        }
        self.proposal = Some(Proposal {
            id: parked.pending_id.clone(),
            steps: parked
                .steps
                .iter()
                .map(|step| Step {
                    summary: step.summary.clone(),
                    destructive: step.destructive,
                })
                .collect(),
            more: parked.more,
            destructive: parked.destructive,
            stage: Stage::Waiting,
            line: String::new(),
        });
    }
}

/// An attachment as the core is handed it: a name, or the bytes a shell picked.
fn wired(held: &Pending) -> wire::AssistAttachment {
    use wire::assist_attachment::Kind as K;
    let kind = match &held.source {
        Source::VaultPhoto(asset_id) => Some(K::VaultPhoto(wire::AssistVaultPhoto {
            asset_id: asset_id.clone(),
        })),
        Source::VaultDocument(doc_id) => Some(K::VaultDoc(wire::AssistVaultDoc {
            doc_id: doc_id.clone(),
        })),
        Source::LibraryPhoto(content, mime) => Some(K::ImageBytes(wire::AssistImageBytes {
            content: content.clone(),
            mime: mime.clone(),
        })),
        // Never handed to the core: a Retry that would lose one is refused.
        Source::Unavailable => None,
    };
    wire::AssistAttachment {
        kind,
        label: held.label.clone(),
    }
}

pub(super) fn card(card: &wire::AssistCard) -> wire::ChatCard {
    wire::ChatCard {
        app: card.app.clone(),
        entity: card.entity.clone(),
        id: card.id.clone(),
        qualifier: card.qualifier.clone(),
        title: card.title.clone(),
        subtitle: card.subtitle.clone(),
        meta: card.meta.clone(),
    }
}

pub(super) fn stored_card(card: &wire::ChatStoredCard) -> wire::ChatCard {
    wire::ChatCard {
        app: card.app.clone(),
        entity: card.entity.clone(),
        id: card.id.clone(),
        qualifier: card.qualifier.clone(),
        title: card.title.clone(),
        subtitle: card.subtitle.clone(),
        meta: card.meta.clone(),
    }
}

/// An app id as a member reads it: the name of the app it opens in.
pub(super) fn app_name(id: &str) -> String {
    centraid_assist::App::from_id(id).map_or_else(|| id.to_owned(), |app| app.display().to_owned())
}
