//! What rides on a question: a photo from the vault or the library, a text document, and the photo
//! reader (the vision projector) a photo needs.

use centraid_api_proto::core_v1 as wire;
use wire::assist_request::Kind as Ask;
use wire::chat_event::attached::Source as From;
use wire::chat_state::Phase;

use super::asset;
use super::model::{Await, Chat, Fail, Pending, Sheet, Source, Vision, VisionPhase, assist, effect};
use crate::screen::Ctx;

impl Chat {
    /// The member chose something. Only while there is a thread to attach it to.
    pub(super) fn attached(&mut self, event: wire::chat_event::Attached, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.ready() || self.running {
            return Vec::new();
        }
        let source = match event.source {
            Some(From::VaultPhoto(photo)) => Source::VaultPhoto(photo.asset_id),
            Some(From::LibraryPhoto(photo)) => Source::LibraryPhoto(photo.content, photo.mime),
            Some(From::VaultDocument(document)) => Source::VaultDocument(document.doc_id),
            None => return Vec::new(),
        };
        let photo = !matches!(source, Source::VaultDocument(_));
        let added = Pending {
            id: self.next_pending,
            photo,
            label: event.label,
            thumbnail_path: event.thumbnail_path,
            source,
        };
        // ONE PHOTO AND ONE DOCUMENT: a second of a kind replaces the first.
        self.pending.retain(|held| held.photo != photo);
        self.pending.push(added);
        self.next_pending += 1;
        self.error = None;
        self.sheet = Sheet::default();
        // A photo needs the projector: find out where it stands, unless that is already known or
        // already being settled.
        let settling = matches!(
            self.vision.phase,
            VisionPhase::Downloading | VisionPhase::Loading
        );
        if photo && !self.vision.ready && !settling {
            return self.read_vision(ctx);
        }
        Vec::new()
    }

    pub(super) fn removed(&mut self, id: u64) -> Vec<wire::Effect> {
        let before = self.pending.len();
        self.pending.retain(|held| held.id != id);
        if self.pending.len() == before {
            return Vec::new();
        }
        // An offer for a reader nobody is waiting on goes away; a download in flight is not
        // interrupted by the photo that asked for it.
        if !self.pending.iter().any(|held| held.photo) && self.vision.phase == VisionPhase::Needs {
            self.vision.phase = VisionPhase::None;
            self.vision.error = None;
        }
        Vec::new()
    }

    /// Whether the photo reader's step has anyone to speak to.
    pub(super) fn wants_reader(&self) -> bool {
        self.pending.iter().any(|held| held.photo) || self.error == Some(Fail::Vision)
    }

    /// Where the projector stands: loaded, on the phone, or not.
    pub(super) fn read_vision(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        // Older than the download that began after it was asked.
        if self.vision.phase == VisionPhase::Downloading {
            return Vec::new();
        }
        let answer = ctx.assist(&assist(Ask::Status(wire::AssistStatusRequest {
            model_path: self.model_path(),
            projector_path: self.projector_path(),
        })));
        let status = match answer.ok().and_then(|answer| answer.kind) {
            Some(wire::assist_response::Kind::Status(status)) => Some(status),
            _ => None,
        };
        let state = status
            .as_ref()
            .and_then(|status| wire::AssistVisionState::try_from(status.vision).ok());
        let known = status
            .as_ref()
            .map(|status| status.projector_bytes)
            .filter(|bytes| *bytes > 0)
            .unwrap_or(self.vision.bytes);
        match state {
            Some(wire::AssistVisionState::Ready) => {
                self.vision = Vision {
                    ready: true,
                    bytes: known,
                    ..Vision::default()
                };
                if self.error == Some(Fail::Vision) {
                    self.error = None;
                }
                Vec::new()
            }
            Some(wire::AssistVisionState::Present) => {
                self.vision.phase = VisionPhase::Loading;
                self.vision.bytes = known;
                self.vision.error = None;
                self.load_vision()
            }
            _ => {
                self.vision.phase = if self.wants_reader() {
                    VisionPhase::Needs
                } else {
                    VisionPhase::None
                };
                self.vision.bytes = known;
                self.vision.ready = false;
                Vec::new()
            }
        }
    }

    fn load_vision(&mut self) -> Vec<wire::Effect> {
        let (model_path, projector_path) = (self.model_path(), self.projector_path());
        vec![self.call(
            Await::LoadVision,
            Ask::Load(wire::AssistLoadRequest {
                model_path,
                projector_path,
            }),
        )]
    }

    pub(super) fn vision_loaded(&mut self, state: Option<wire::AssistVisionState>) -> Vec<wire::Effect> {
        if self.vision.phase != VisionPhase::Loading {
            return Vec::new();
        }
        if state == Some(wire::AssistVisionState::Ready) {
            self.vision = Vision {
                ready: true,
                bytes: self.vision.bytes,
                ..Vision::default()
            };
            if self.error == Some(Fail::Vision) {
                self.error = None;
            }
            return Vec::new();
        }
        // A projector that will not load is a projector to fetch again.
        self.vision.phase = VisionPhase::Needs;
        self.vision.ready = false;
        self.vision.progress = None;
        self.vision.error = Some(Fail::VisionLoadFailed);
        Vec::new()
    }

    pub(super) fn vision_finished(&mut self, ok: bool) -> Vec<wire::Effect> {
        if self.vision.phase != VisionPhase::Downloading {
            return Vec::new();
        }
        self.vision.progress = None;
        if ok {
            self.vision.phase = VisionPhase::Loading;
            self.load_vision()
        } else {
            self.vision.phase = VisionPhase::Needs;
            self.vision.error = Some(Fail::DownloadStopped);
            Vec::new()
        }
    }

    pub(super) fn library_photo_tapped(&mut self) -> Vec<wire::Effect> {
        if !self.ready() || self.running {
            return Vec::new();
        }
        vec![effect(wire::effect::Kind::PickLibraryPhoto(wire::PickLibraryPhoto {}))]
    }

    pub(super) fn library_photo_picked(&mut self, picked: wire::LibraryPhotoPicked, ctx: &Ctx) -> Vec<wire::Effect> {
        if picked.cancelled {
            return Vec::new();
        }
        if picked.unreadable || picked.content.is_empty() {
            self.error = Some(Fail::AttachUnreadable);
            return Vec::new();
        }
        self.attached(
            wire::chat_event::Attached {
                source: Some(From::LibraryPhoto(wire::chat_event::LibraryPhoto {
                    content: picked.content,
                    mime: picked.mime,
                })),
                label: String::new(),
                thumbnail_path: picked.thumbnail_path,
            },
            ctx,
        )
    }

    /// The vault's text documents, newest edit first. A PDF is not listed: the core lists only
    /// what an attach would not refuse.
    pub(super) fn documents_opened(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.ready() || self.running {
            return Vec::new();
        }
        let answer = ctx.assist(&assist(Ask::Documents(wire::AssistDocumentsRequest { limit: 50 })));
        let rows = match answer.ok().and_then(|answer| answer.kind) {
            Some(wire::assist_response::Kind::Documents(documents)) => documents.documents,
            _ => Vec::new(),
        };
        self.sheet = Sheet {
            open: true,
            loaded: true,
            rows,
        };
        Vec::new()
    }

    /// Whether a phase takes an attachment at all.
    pub(super) fn can_attach(&self) -> bool {
        self.phase == Phase::Ready && self.session != 0 && !self.running
    }

    /// The reader's download size quoted before a byte has moved.
    pub(super) fn vision_bytes(&self) -> u64 {
        if self.vision.bytes > 0 {
            self.vision.bytes
        } else {
            asset::VISION.bytes
        }
    }
}
