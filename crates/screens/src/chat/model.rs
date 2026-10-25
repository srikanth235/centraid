//! What the chat knows, the model's phases, and the events that are not a turn's.

use centraid_api_proto::core_v1 as wire;
use prost::Message;
use wire::assist_request::Kind as Ask;
use wire::chat_event::Kind as E;
use wire::chat_state::Phase;

use super::{asset, when};
use crate::screen::Ctx;
use crate::strings::chat as words;

/// The most suggestions the thread's empty state offers.
pub(super) const SUGGESTIONS: usize = 3;

/// One message in the transcript, as the screen holds it.
#[derive(Clone, Debug, Default)]
pub(super) struct Msg {
    pub id: u64,
    pub user: bool,
    pub text: String,
    pub cards: Vec<wire::ChatCard>,
    pub streaming: bool,
    pub stopped: bool,
    /// What the member attached to this question: shown as chips, never as bytes.
    pub attachments: Vec<Pending>,
    /// The attached document was cut before the model read it.
    pub truncated: bool,
    /// The write this answer proposes, until the thread is left.
    pub proposal: Option<Proposal>,
}

/// Where a proposed write stands. It moves forward once and never back, except WORKING to
/// WAITING when the call failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Waiting,
    Working,
    Applied,
    NotDone,
    Stale,
    Inert,
}

#[derive(Clone, Debug)]
pub(super) struct Step {
    pub summary: String,
    pub destructive: bool,
}

/// A write the model proposed and the core parked, waiting on the member's tap.
#[derive(Clone, Debug)]
pub(super) struct Proposal {
    /// What the core named it by; empty on a card drawn from a stored `proposed` answer.
    pub id: String,
    pub steps: Vec<Step>,
    pub more: u32,
    pub destructive: bool,
    pub stage: Stage,
    /// How it ended, once it has.
    pub line: String,
}

/// Where an attachment comes from: what the core is handed, by name or by bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Source {
    VaultPhoto(String),
    /// JPEG or PNG bytes a shell picked; HEIC is converted by the shell first.
    LibraryPhoto(Vec<u8>, String),
    VaultDocument(String),
    /// A stored attachment that cannot be sent again: a camera-roll image kept only as a
    /// thumbnail, or a vault photo or document since deleted.
    Unavailable,
}

/// One attachment, from the moment it waits in the composer until the chat is cleared.
#[derive(Clone, Debug)]
pub(super) struct Pending {
    pub id: u64,
    pub photo: bool,
    pub label: String,
    pub thumbnail_path: String,
    pub source: Source,
}

/// The one line a failure is told in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Fail {
    NoTool,
    Read,
    Model,
    Vision,
    AttachUnsupported,
    AttachUnreadable,
    AttachTooLarge,
    Generic,
    ThreadGone,
    DownloadStopped,
    LoadFailed,
    VisionLoadFailed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum VisionPhase {
    #[default]
    None,
    Needs,
    Downloading,
    Loading,
}

/// Whether the loaded model can read a photo, and the step on the way there.
#[derive(Clone, Debug, Default)]
pub(super) struct Vision {
    pub phase: VisionPhase,
    pub ready: bool,
    pub bytes: u64,
    pub progress: Option<f32>,
    pub error: Option<Fail>,
}

impl Vision {
    /// A model that was unloaded took its projector with it.
    pub fn unloaded(&self) -> Self {
        Self {
            bytes: self.bytes,
            ..Self::default()
        }
    }
}

/// One past chat, as the drawer's read answered it.
#[derive(Clone, Debug)]
pub(super) struct Row {
    pub id: String,
    pub title: String,
    pub updated_ms: i64,
}

/// The drawer's search field.
#[derive(Clone, Debug, Default)]
pub(super) struct Search {
    pub open: bool,
    pub term: String,
    /// The term the rows in `found` answer.
    pub answered: String,
    pub corrected: String,
}

/// A call the shell was asked to make and has not answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Await {
    Load,
    LoadVision,
    Send(u64),
}

/// A question asked on the member's behalf (a search's Ask) before the chat could take it.
#[derive(Clone, Debug)]
pub(super) struct Waiting {
    pub question: String,
}

/// The documents sheet.
#[derive(Clone, Debug, Default)]
pub(super) struct Sheet {
    pub open: bool,
    pub loaded: bool,
    pub rows: Vec<wire::AssistDocument>,
}

/// The chat's state.
pub(super) struct Chat {
    pub phase: Phase,
    /// The app the chat was opened from, or empty.
    pub scope: String,
    /// Whether the tab has opened this chat at all.
    pub opened: bool,
    pub models_dir: String,
    pub vault_name: String,
    /// The core's session id, 0 until it has started one.
    pub session: u64,
    /// The last turn id minted; the running turn's, while `running`.
    pub turn: u64,
    pub next_id: u64,
    pub messages: Vec<Msg>,
    pub suggestions: Vec<String>,
    pub running: bool,
    pub activity: String,
    pub error: Option<Fail>,
    pub progress: Option<f32>,
    /// The last question put to the core, for Retry.
    pub asked: Option<String>,
    /// What waits in the composer.
    pub pending: Vec<Pending>,
    pub next_pending: u64,
    /// The last turn's attachments, asked again by Retry.
    pub last_sent: Vec<Pending>,
    pub vision: Vision,
    /// The stored thread this chat is saved in, or empty until a turn has been saved.
    pub thread_id: String,
    pub thread_title: String,
    pub drawer_open: bool,
    pub threads: Vec<Row>,
    pub now_ms: i64,
    pub search: Search,
    pub found: Option<Vec<Row>>,
    pub sheet: Sheet,
    /// A tapped card's row is gone: the line says so until the next gesture.
    pub card_gone: bool,
    pub awaiting: Vec<Await>,
    pub waiting: Option<Waiting>,
    /// The card whose confirm is held for the owner check.
    pub unlocking: Option<String>,
    /// Invoke-key sequence for this screen's writes.
    pub seq: u64,
}

impl Default for Chat {
    fn default() -> Self {
        Self {
            phase: Phase::Checking,
            scope: String::new(),
            opened: false,
            models_dir: String::new(),
            vault_name: String::new(),
            session: 0,
            turn: 0,
            next_id: 1,
            messages: Vec::new(),
            suggestions: Vec::new(),
            running: false,
            activity: String::new(),
            error: None,
            progress: None,
            asked: None,
            pending: Vec::new(),
            next_pending: 1,
            last_sent: Vec::new(),
            vision: Vision::default(),
            thread_id: String::new(),
            thread_title: String::new(),
            drawer_open: false,
            threads: Vec::new(),
            now_ms: 0,
            search: Search::default(),
            found: None,
            sheet: Sheet::default(),
            card_gone: false,
            awaiting: Vec::new(),
            waiting: None,
            unlocking: None,
            seq: crate::kit::act::fresh(),
        }
    }
}

pub(super) fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

pub(super) fn assist(kind: Ask) -> wire::AssistRequest {
    wire::AssistRequest { kind: Some(kind) }
}

impl Chat {
    /// A chat opened by a search's Ask: scoped, with the question waiting for the model.
    pub fn asking(scope: &str, question: &str) -> Self {
        Self {
            scope: scope.to_owned(),
            waiting: (!question.trim().is_empty()).then(|| Waiting {
                question: question.trim().to_owned(),
            }),
            ..Self::default()
        }
    }

    /// A model path in the shell's models directory.
    pub fn model_path(&self) -> String {
        asset::path(&self.models_dir, &asset::MODEL)
    }

    pub fn projector_path(&self) -> String {
        asset::path(&self.models_dir, &asset::VISION)
    }

    /// Whether a session is up and nothing else is in the way of a question.
    pub fn ready(&self) -> bool {
        self.phase == Phase::Ready && self.session != 0
    }

    /// Whether a question sent now would be asked and not dropped.
    pub fn can_ask(&self) -> bool {
        self.ready() && !self.running
    }

    /// A call that blocks for seconds (a model load, a whole turn) runs on the core's pool, off
    /// the runtime lock; its answer returns as `OffThreadDone` ([`Chat::job_done`]).
    pub fn call(&mut self, ctx: &Ctx, wait: Await, kind: Ask) {
        let tag = match wait {
            Await::Load => "load".to_owned(),
            Await::LoadVision => "load-vision".to_owned(),
            Await::Send(turn) => format!("send:{turn}"),
        };
        self.awaiting.push(wait);
        let request = assist(kind);
        ctx.off_thread(&tag, move |core| {
            core.assist(&request)
                .map(|answer| answer.encode_to_vec())
                .unwrap_or_default()
        });
    }

    pub fn on_event(&mut self, event: E, ctx: &Ctx) -> Vec<wire::Effect> {
        // Any gesture ends the "this item is gone" line.
        if !matches!(event, E::Opened(_) | E::CardTapped(_)) {
            self.card_gone = false;
        }
        match event {
            E::Opened(opened) => self.opened(opened, ctx),
            E::Sent(sent) => self.asked_by_member(&sent.text, ctx),
            E::Stopped(_) => self.stopped(ctx),
            E::Regenerated(_) => self.regenerated(ctx),
            E::NewChat(_) => self.new_chat(ctx),
            E::Copied(copied) => self.copied(copied.message_id),
            E::Download(download) => self.download_tapped(download.vision),
            E::DownloadProgress(progress) => self.progressed(&progress, ctx),
            E::DownloadFinished(done) => self.download_finished(done.vision, done.ok, ctx),
            E::Attached(attached) => self.attached(attached, ctx),
            E::AttachmentRemoved(removed) => self.removed(removed.id),
            E::Drawer(toggle) => self.drawer_toggled(toggle.opened, ctx),
            E::ThreadOpened(opened) => self.thread_opened(&opened.thread_id, &opened.title, ctx),
            E::ThreadRenamed(renamed) => self.thread_renamed(&renamed.thread_id, &renamed.title, ctx),
            E::ThreadDeleted(deleted) => self.thread_deleted(&deleted.thread_id, ctx),
            E::AllThreadsDeleted(_) => self.all_threads_deleted(ctx),
            E::PendingConfirmed(confirmed) => self.confirm_tapped(&confirmed.pending_id, ctx),
            E::PendingCancelled(cancelled) => self.cancel_tapped(&cancelled.pending_id, ctx),
            E::DrawerSearchOpened(_) => self.search_opened(),
            E::DrawerSearchTerm(term) => self.search_term(&term.term, ctx),
            E::DrawerSearchClosed(_) => self.search_closed(),
            E::Asked(asked) => self.asked_on_behalf(&asked.scope, &asked.question, ctx),
            E::CardTapped(tapped) => self.card_tapped(tapped.message_id, tapped.index as usize, ctx),
            E::LibraryPhotoTapped(_) => self.library_photo_tapped(),
            E::DocumentsOpened(_) => self.documents_opened(ctx),
            E::DocumentsClosed(_) => {
                self.sheet = Sheet::default();
                Vec::new()
            }
        }
    }

    /// The tab appeared, or the member chose a scope.
    ///
    /// A tab appearing changes nothing about a chat that has something in it: the thread survives
    /// a switch of tab, and a thread opened from the drawer keeps ITS scope, which the shell has
    /// never heard of. It adopts the app it was opened from only while there is nothing to lose:
    /// no messages and no stored thread. A scope CHOSEN from the composer's menu starts over when
    /// it differs. Either way the vault's name is kept current, a chat still waiting on a model
    /// looks again (the file may have arrived while another tab was up), and the drawer's list is
    /// read afresh.
    fn opened(&mut self, opened: wire::chat_event::Opened, ctx: &Ctx) -> Vec<wire::Effect> {
        if !opened.models_dir.is_empty() {
            self.models_dir = opened.models_dir;
        }
        if !opened.vault_name.is_empty() {
            self.vault_name = opened.vault_name;
        }
        let untouched = self.messages.is_empty() && self.thread_id.is_empty();
        // A chat made by a search's Ask already has its scope: the shell's first `opened` only
        // starts it.
        let asked = if !self.opened && self.waiting.is_some() {
            self.scope.clone()
        } else {
            super::scope_of(&opened.app)
        };
        let rescope = self.opened && self.scope != asked && (opened.scope_chosen || untouched);
        if self.opened && !rescope {
            let mut effects = Vec::new();
            if matches!(self.phase, Phase::NeedsModel | Phase::Unavailable) {
                effects.extend(self.read_status(ctx));
            }
            if !self.running {
                self.read_threads(ctx);
            }
            return effects;
        }
        let mut effects = Vec::new();
        if self.running && self.session != 0 {
            self.cancel_remote(ctx);
        }
        let threads = std::mem::take(&mut self.threads);
        let models_dir = std::mem::take(&mut self.models_dir);
        let vault_name = std::mem::take(&mut self.vault_name);
        let waiting = self.waiting.take();
        *self = Self {
            opened: true,
            waiting,
            scope: asked,
            models_dir,
            vault_name,
            threads,
            now_ms: self.now_ms,
            turn: self.turn + 1,
            ..Self::default()
        };
        effects.extend(self.read_status(ctx));
        self.read_threads(ctx);
        effects
    }

    /// Ask the core where the model stands and act on it.
    pub fn read_status(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        // A status read that was in flight when the download began is older than the download.
        if self.phase == Phase::Downloading {
            return Vec::new();
        }
        let answer = ctx.assist(&assist(Ask::Status(wire::AssistStatusRequest {
            model_path: self.model_path(),
            projector_path: String::new(),
        })));
        let state = match answer.ok().and_then(|answer| answer.kind) {
            Some(wire::assist_response::Kind::Status(status)) => {
                wire::AssistModelState::try_from(status.state).ok()
            }
            _ => None,
        };
        match state {
            Some(wire::AssistModelState::Absent) => {
                self.phase = Phase::NeedsModel;
                self.progress = None;
                Vec::new()
            }
            Some(wire::AssistModelState::Present) => {
                self.phase = Phase::Loading;
                // The projector belongs to the loaded model: a model about to be loaded has none.
                self.vision = self.vision.unloaded();
                self.load_effect(ctx)
            }
            Some(wire::AssistModelState::Loading) => {
                self.phase = Phase::Loading;
                Vec::new()
            }
            Some(wire::AssistModelState::Ready) => self.became_ready(ctx),
            // NO_ENGINE, a core that would not answer, and a state this build has no name for
            // are all "not available here".
            _ => {
                self.phase = Phase::Unavailable;
                Vec::new()
            }
        }
    }

    fn load_effect(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let model_path = self.model_path();
        self.call(
            ctx,
            Await::Load,
            Ask::Load(wire::AssistLoadRequest {
                model_path,
                projector_path: String::new(),
            }),
        );
        Vec::new()
    }

    fn loaded(&mut self, state: Option<wire::AssistModelState>, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.phase != Phase::Loading {
            return Vec::new();
        }
        if state == Some(wire::AssistModelState::Ready) {
            return self.became_ready(ctx);
        }
        // A file that will not load is a file to fetch again.
        self.phase = Phase::NeedsModel;
        self.error = Some(Fail::LoadFailed);
        Vec::new()
    }

    fn became_ready(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.phase = Phase::Ready;
        self.progress = None;
        self.error = None;
        if self.session != 0 {
            return Vec::new();
        }
        self.start_session(ctx);
        self.ask_waiting(ctx)
    }

    /// Open a session on the scope; a refusal is "not available here".
    fn start_session(&mut self, ctx: &Ctx) {
        let started = ctx.assist(&assist(Ask::Start(wire::AssistStartRequest {
            app: self.scope.clone(),
            thread_id: String::new(),
        })));
        match started.ok().and_then(|answer| answer.kind) {
            Some(wire::assist_response::Kind::Started(started)) => {
                self.session = started.session_id;
                if self.messages.is_empty() {
                    self.suggest(ctx);
                }
            }
            _ => self.phase = Phase::Unavailable,
        }
    }

    pub fn suggest(&mut self, ctx: &Ctx) {
        let answer = ctx.assist(&assist(Ask::Suggest(wire::AssistSuggestRequest {
            app: self.scope.clone(),
            tz: ctx.zone().to_owned(),
        })));
        if let Some(wire::assist_response::Kind::Suggestions(found)) =
            answer.ok().and_then(|answer| answer.kind)
            && self.messages.is_empty()
        {
            self.suggestions = found
                .prompts
                .into_iter()
                .filter(|prompt| !prompt.trim().is_empty())
                .take(SUGGESTIONS)
                .collect();
        }
    }

    /// An Ask that arrived before the chat could take it is put now.
    fn ask_waiting(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        match self.waiting.take() {
            Some(waiting) if self.can_ask() => self.ask(&waiting.question, false, ctx),
            Some(waiting) => {
                self.waiting = Some(waiting);
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    fn download_tapped(&mut self, vision: bool) -> Vec<wire::Effect> {
        let model = if vision { asset::VISION } else { asset::MODEL };
        if vision {
            if self.vision.phase != VisionPhase::Needs {
                return Vec::new();
            }
            self.vision.phase = VisionPhase::Downloading;
            self.vision.progress = None;
            self.vision.error = None;
        } else {
            if self.phase != Phase::NeedsModel {
                return Vec::new();
            }
            self.phase = Phase::Downloading;
            self.progress = None;
            self.error = None;
        }
        vec![effect(wire::effect::Kind::ModelDownload(wire::ModelDownload {
            vision,
            url: model.url.to_owned(),
            file_name: model.file_name.to_owned(),
            sha256: model.sha256.to_owned(),
            bytes: model.bytes,
            models_dir: self.models_dir.clone(),
        }))]
    }

    /// A transfer reported progress.
    ///
    /// While the chat is DOWNLOADING that moves the bar. While it is CHECKING or NEEDS_MODEL it is
    /// the other thing progress can mean: a download the shell started in an earlier launch is
    /// STILL RUNNING (a background transfer outlives the app), and the shell said so on this
    /// launch. The chat goes to DOWNLOADING at once instead of offering "Download model" over a
    /// transfer that is already half done. No effect: the transfer is already going.
    fn progressed(&mut self, progress: &wire::chat_event::DownloadProgress, _ctx: &Ctx) -> Vec<wire::Effect> {
        let fraction = (progress.total_bytes > 0).then(|| {
            (progress.done_bytes as f32 / progress.total_bytes as f32).clamp(0.0, 1.0)
        });
        if progress.vision {
            self.vision.phase = VisionPhase::Downloading;
            self.vision.progress = fraction;
            self.vision.error = None;
            return Vec::new();
        }
        let resumed = matches!(self.phase, Phase::Checking | Phase::NeedsModel);
        if self.phase != Phase::Downloading && !resumed {
            return Vec::new();
        }
        self.phase = Phase::Downloading;
        self.progress = fraction;
        if resumed {
            self.error = None;
        }
        Vec::new()
    }

    fn download_finished(&mut self, vision: bool, ok: bool, ctx: &Ctx) -> Vec<wire::Effect> {
        if vision {
            return self.vision_finished(ok, ctx);
        }
        if self.phase != Phase::Downloading {
            return Vec::new();
        }
        if ok {
            self.phase = Phase::Loading;
            self.progress = None;
            self.load_effect(ctx)
        } else {
            self.phase = Phase::NeedsModel;
            self.progress = None;
            self.error = Some(Fail::DownloadStopped);
            let _ = ctx;
            Vec::new()
        }
    }

    pub fn on_data_changed(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.opened {
            self.read_threads(ctx);
        }
        Vec::new()
    }

    /// What a shell's answer to an effect means to this screen.
    pub fn on_effect(&mut self, result: wire::EffectResult, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome as O;
        match result.outcome {
            Some(O::OwnerChecked(checked)) => self.owner_checked(&checked, ctx),
            Some(O::LibraryPhotoPicked(picked)) => self.library_photo_picked(picked, ctx),
            _ => Vec::new(),
        }
    }

    /// A job finished: its bytes are the encoded `AssistResponse`, or nothing when the call
    /// itself failed (the one failure path).
    pub fn job_done(&mut self, tag: &str, bytes: &[u8], ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::assist_response::Kind as K;
        let answer = if bytes.is_empty() {
            None
        } else {
            wire::AssistResponse::decode(bytes).ok()
        };
        let wait = match tag {
            "load" => Await::Load,
            "load-vision" => Await::LoadVision,
            send => match send.strip_prefix("send:").and_then(|turn| turn.parse().ok()) {
                Some(turn) => Await::Send(turn),
                None => return Vec::new(),
            },
        };
        self.awaiting.retain(|held| *held != wait);
        match (wait, answer.and_then(|answer| answer.kind)) {
            (Await::Load, Some(K::Status(status))) => {
                self.loaded(wire::AssistModelState::try_from(status.state).ok(), ctx)
            }
            (Await::Load, _) => self.loaded(None, ctx),
            (Await::LoadVision, Some(K::Status(status))) => {
                self.vision_loaded(wire::AssistVisionState::try_from(status.vision).ok())
            }
            (Await::LoadVision, _) => self.vision_loaded(None),
            (Await::Send(turn), Some(K::Sent(sent))) => self.settled(turn, Some(sent), ctx),
            (Await::Send(turn), _) => self.settled(turn, None, ctx),
        }
    }

    /// Tell the core to stop the running turn. A cancel with nothing running is a no-op.
    pub fn cancel_remote(&self, ctx: &Ctx) {
        let _ = ctx.assist(&assist(Ask::Cancel(wire::AssistCancelRequest {
            session_id: self.session,
        })));
    }

    pub fn clock(&mut self) {
        self.now_ms = when::now_ms();
    }

    pub fn fail_line(&self, fail: Fail, locale: crate::strings::Locale) -> String {
        match fail {
            Fail::NoTool => words::error_no_tool(locale),
            Fail::Read => words::error_read(locale),
            Fail::Model => words::error_model(locale),
            Fail::Vision => words::error_vision(locale),
            Fail::AttachUnsupported => words::error_attach_unsupported(locale),
            Fail::AttachUnreadable => words::error_attach_unreadable(locale),
            Fail::AttachTooLarge => words::error_attach_too_large(locale),
            Fail::Generic => words::error_generic(locale),
            Fail::ThreadGone => words::error_thread_gone(locale),
            Fail::DownloadStopped => words::download_failed(locale),
            Fail::LoadFailed => words::load_failed(locale),
            Fail::VisionLoadFailed => words::vision_load_failed(locale),
        }
    }
}
