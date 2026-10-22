//! ADDING A DOCUMENT (#1047, R-1047-Q4): Upload, Scan and Text from the drive's
//! Add sheet, as one small machine the drive holds.
//!
//! ```text
//!   request ─┬─ UPLOAD/SCAN ─> PICKING ─FilePicked─> FILING ─> FILED
//!            └─ TEXT ──────────────────────────────> FILING ─> FILED
//!   any refusal ─> FAILED ─Retry─> (FILING with the file held, else PICKING)
//! ```
//!
//! **The shell picks and stages; the screen files.** `PickFile` asks the
//! platform's file picker or document scanner, copies the choice to a file on
//! this device and streams it through the stage door; the shell answers
//! `FilePicked` with the hash the core named and the bytes it counted. Everything
//! after that is one `act`: `upload` (the staged bytes become a document) or
//! `create-text` (the words become the bytes). The write is answered at once, so
//! FILING is a phase only inside one update.
//!
//! One ingest at a time: a request while one is picking or filing is nothing. A
//! FILED text document opens its editor, anything else its page, through the
//! generic `OpenRoute` effect: wherever the member is when the filing lands, with
//! the page the Add sheet was on as its back word.

use centraid_api_proto::core_v1 as wire;
use wire::docs_ingest_view::Phase;

use crate::catalog::act;
use crate::docs::routes;
use crate::kit::act as kit_act;
use crate::screen::Ctx;
use crate::strings::{Locale, docs as words, fill};

const PERMILLE: u64 = 1000;
const OCTET_STREAM: &str = "application/octet-stream";

/// What an Add row asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Upload,
    Scan,
    Text,
}

/// The file the shell staged: kept so Try again files it without asking the
/// picker again.
#[derive(Clone, Debug)]
struct Staged {
    blob: String,
    size: u64,
    media_type: String,
}

/// One ingest.
#[derive(Debug)]
pub struct Ingest {
    phase: Phase,
    kind: Kind,
    folder_id: String,
    title: String,
    file: Option<Staged>,
    failure: String,
    staged_bytes: u64,
    total_bytes: u64,
    /// The page the Add sheet was on: the filed document's back word.
    parent: String,
}

impl Default for Ingest {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            kind: Kind::Upload,
            folder_id: String::new(),
            title: String::new(),
            file: None,
            failure: String::new(),
            staged_bytes: 0,
            total_bytes: 0,
            parent: String::new(),
        }
    }
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

impl Ingest {
    /// Whether an ingest is under way, so a second request is nothing.
    #[must_use]
    pub fn busy(&self) -> bool {
        matches!(self.phase, Phase::Picking | Phase::Filing)
    }

    /// The Add sheet's row.
    pub fn request(
        &mut self,
        ctx: &Ctx,
        kind: Kind,
        folder_id: &str,
        parent: &str,
    ) -> Vec<wire::Effect> {
        if self.busy() {
            return Vec::new();
        }
        *self = Self {
            kind,
            folder_id: folder_id.to_owned(),
            parent: parent.to_owned(),
            ..Self::default()
        };
        match kind {
            Kind::Text => {
                self.title = words::ingest_text_title(ctx.locale());
                self.file_it(ctx)
            }
            Kind::Upload | Kind::Scan => self.pick(),
        }
    }

    fn pick(&mut self) -> Vec<wire::Effect> {
        self.phase = Phase::Picking;
        self.failure.clear();
        vec![effect(wire::effect::Kind::PickFile(wire::PickFile {
            kind: match self.kind {
                Kind::Scan => wire::pick_file::Kind::Scan,
                _ => wire::pick_file::Kind::Upload,
            } as i32,
        }))]
    }

    /// The shell's answer to `PickFile`. `None` when this ingest is not waiting
    /// for one, so the caller can offer it to whoever is.
    pub fn result(
        &mut self,
        ctx: &Ctx,
        outcome: &wire::effect_result::Outcome,
    ) -> Option<Vec<wire::Effect>> {
        use wire::effect_result::Outcome as O;
        if self.phase != Phase::Picking {
            return None;
        }
        match outcome {
            O::FileProgress(progress) => {
                self.staged_bytes = progress.staged_bytes;
                self.total_bytes = progress.total_bytes;
                Some(Vec::new())
            }
            O::FilePicked(picked) => {
                self.title = title_of(ctx.locale(), self.kind, &picked.name);
                self.total_bytes = picked.byte_size;
                self.staged_bytes = picked.byte_size;
                self.file = Some(Staged {
                    blob: picked.blob.clone(),
                    size: picked.byte_size,
                    media_type: media_type_of(&picked.name, &picked.media_type),
                });
                Some(self.file_it(ctx))
            }
            // THE MEMBER CLOSED THE PICKER: nothing happened, so nothing is said.
            O::Done(_) => {
                *self = Self::default();
                Some(Vec::new())
            }
            O::Failed(failed) => {
                self.fail(refusal_of(ctx.locale(), self.kind, failed));
                Some(Vec::new())
            }
            _ => None,
        }
    }

    /// Try again, after a failure.
    pub fn retry(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.phase != Phase::Failed {
            return Vec::new();
        }
        self.staged_bytes = 0;
        if self.kind == Kind::Text || self.file.is_some() {
            self.file_it(ctx)
        } else {
            self.pick()
        }
    }

    /// Put the status away (a failure, or a filed document's line).
    pub fn dismiss(&mut self) {
        if !self.busy() {
            *self = Self::default();
        }
    }

    fn fail(&mut self, sentence: String) {
        self.phase = Phase::Failed;
        self.failure = sentence;
    }

    /// The write that files this ingest. Not keyed on anything the vault keeps:
    /// a failed filing rolled back, so Try again is a fresh write.
    fn file_it(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.phase = Phase::Filing;
        let folder_id = Some(self.folder_id.clone()).filter(|id| !id.is_empty());
        let (request, subject): (wire::ActRequest, String) = match (&self.file, self.kind) {
            (_, Kind::Text) => (
                act::docs::CreateText {
                    title: self.title.clone(),
                    folder_id,
                    ..Default::default()
                }
                .into(),
                self.title.clone(),
            ),
            (Some(file), _) => (
                act::docs::Upload {
                    blob: file.blob.clone(),
                    media_type: file.media_type.clone(),
                    title: self.title.clone(),
                    folder_id,
                    size: i64::try_from(file.size).ok(),
                    ..Default::default()
                }
                .into(),
                file.blob.clone(),
            ),
            (None, _) => {
                self.fail(words::ingest_no_file(ctx.locale()));
                return Vec::new();
            }
        };
        let key = kit_act::key(&[&request.action, &subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            let sentence = if settled.refusal.trim().is_empty() {
                words::ingest_no_file(ctx.locale())
            } else {
                settled.refusal
            };
            self.fail(sentence);
            return Vec::new();
        }
        self.phase = Phase::Filed;
        self.file = None;
        let Some(id) = settled.output_text("id") else {
            return Vec::new();
        };
        let route = if self.kind == Kind::Text {
            routes::editor(&id, &self.title)
        } else {
            let parent = if self.parent.is_empty() {
                words::app_title(ctx.locale())
            } else {
                self.parent.clone()
            };
            routes::document(&id, &self.title, &parent)
        };
        vec![effect(wire::effect::Kind::OpenRoute(wire::OpenRoute {
            route: Some(route),
        }))]
    }

    /// The words and the bar, from the phase — every view.
    #[must_use]
    pub fn view(&self, locale: Locale) -> wire::DocsIngestView {
        let status_label = match self.phase {
            Phase::Filing => fill(&words::ingest_adding(locale), &[("title", &self.title)]),
            Phase::Filed => fill(&words::ingest_added(locale), &[("title", &self.title)]),
            Phase::Failed => self.failure.clone(),
            _ => String::new(),
        };
        let failed = self.phase == Phase::Failed;
        let progress = match self.phase {
            Phase::Filing | Phase::Filed => PERMILLE,
            _ if self.total_bytes > 0 => {
                self.staged_bytes.min(self.total_bytes) * PERMILLE / self.total_bytes
            }
            _ => 0,
        };
        wire::DocsIngestView {
            phase: self.phase as i32,
            status_label,
            progress_permille: u32::try_from(progress).unwrap_or(0),
            // One text action (Try again, on a failure) and a close key on any
            // settled line (DESIGN.md's StatusLine); the line never clears itself.
            retry_label: if failed {
                words::retry(locale)
            } else {
                String::new()
            },
            dismiss_label: if failed || self.phase == Phase::Filed {
                words::ingest_dismiss(locale)
            } else {
                String::new()
            },
        }
    }
}

/// The file's name as its title; a scan with none is "Scanned document".
fn title_of(locale: Locale, kind: Kind, name: &str) -> String {
    let name = name.trim();
    if !name.is_empty() {
        name.to_owned()
    } else if kind == Kind::Scan {
        words::ingest_scan_title(locale)
    } else {
        words::untitled(locale)
    }
}

/// WHY IT FAILED, IN THE MEMBER'S WORDS: a refused grant says where to turn it
/// on; a phone with no picker says so; anything else is the file that would not
/// read.
fn refusal_of(locale: Locale, kind: Kind, failed: &wire::EffectFailed) -> String {
    match (failed.denied, kind) {
        (true, Kind::Scan) => words::camera_denied(locale),
        (true, _) => words::files_denied(locale),
        _ if failed.reason == UNAVAILABLE => words::ingest_no_picker(locale),
        _ => words::ingest_no_file(locale),
    }
}

/// The reason a shell gives when this phone has no picker or scanner to offer.
pub const UNAVAILABLE: &str = "unavailable";

/// A media type for a file the platform named none for, off its name — the core
/// has no sniffer, and bytes promoted as `application/octet-stream` are ones no
/// stage will draw.
#[must_use]
pub fn media_type_of(name: &str, stated: &str) -> String {
    if !stated.trim().is_empty() {
        return stated.trim().to_owned();
    }
    let extension = name.rsplit_once('.').map_or("", |(_, ext)| ext).to_lowercase();
    match extension.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "heic" => "image/heic",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => OCTET_STREAM,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_says_its_media_type_unless_the_platform_did() {
        assert_eq!(media_type_of("Lease.PDF", ""), "application/pdf");
        assert_eq!(media_type_of("notes", ""), OCTET_STREAM);
        assert_eq!(media_type_of("x.pdf", " image/png "), "image/png");
    }

    #[test]
    fn a_scan_with_no_name_is_a_scanned_document() {
        assert_eq!(title_of(Locale::En, Kind::Scan, " "), "Scanned document");
        assert_eq!(title_of(Locale::En, Kind::Upload, ""), "Untitled");
        assert_eq!(title_of(Locale::En, Kind::Upload, " a.pdf "), "a.pdf");
    }
}
