//! THE ATTACHMENTS SECTION of an event or a task page (#1173): the photos and files
//! on one item, a page at a time, and the controls that attach, open and detach them.
//! The two pages hold one of these each, so the two shells draw one section.
//!
//! ```text
//!   Add photo / Add file ─PickFile─> (FileProgress)* ─FilePicked─> photo.add | document.add
//!                                                                   └─> attach (edge.add)
//!   a row's Remove ─> confirm ─Confirmed─> detach (edge.remove)
//! ```
//!
//! **The shell picks and stages; the screen files and attaches.** `PickFile` asks the
//! platform's photo library (`KIND_PHOTO`) or file picker (`KIND_UPLOAD`) and streams the
//! choice through the stage door; the answer names the staged blob. The photo or file is then
//! made in Photos or Docs as it would be there (`photo.add`, `document.add`: identical bytes
//! adopt the one that is there) and attached to the item with `attach`. Removing is `detach`:
//! it takes the attachment off the item and nothing else, so the photo or file stays in its own
//! app, and the confirm says so.
//!
//! **A tap opens the photo or file where it lives.** A row carries the route of Photos' viewer
//! or of the Docs page; the shell pushes it, and this section names no screen of its own.
//!
//! Reads are `calendar.attachments` or `reminders.attachments`, a keyset page. The first page is read again after every
//! change (as many rows as are shown, up to the page maximum); Show more reads the next.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::page::format_byte_size;
use wire::agenda_attachment_event::Kind as K;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;

use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::shell::row_routes::{self, RowRef};
use crate::strings::{Locale, agenda as agenda_words, agenda_event as words, fill};

/// Rows a first read asks for, and a Show more.
const PAGE: usize = 30;
/// The most rows one `calendar.attachments` or `reminders.attachments` page answers (the read's own maximum).
const PAGE_MAX: usize = 100;
/// The reason a shell gives when this phone has no picker to offer.
pub const UNAVAILABLE: &str = "unavailable";
const OCTET_STREAM: &str = "application/octet-stream";
const PHOTO: &str = "photo";

/// The icon keys of `design/icons.toml` this section draws.
const ICON_PHOTO: &str = "Image";
const ICON_FILE: &str = "FileText";
/// The paperclip on the Add file key, which the board draws beside Add photo.
const ICON_ADD_FILE: &str = "Paperclip";

/// What an add asks the shell for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pick {
    Photo,
    File,
}

/// A pick the shell has not finished: the name it is streaming, once it says.
#[derive(Clone, Debug)]
struct Waiting {
    pick: Pick,
    name: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Loaded {
    #[default]
    Unread,
    Read,
    Failed,
}

/// Whose attachments a page holds: an event's (Calendar) or a task's (Reminders).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Of {
    #[default]
    Event,
    Task,
}

/// One item's attachments, as its page holds them.
#[derive(Debug, Default)]
pub struct Attachments {
    item_id: String,
    /// Whose attachments these are: an event's are Calendar's, a task's are Reminders'.
    of: Of,
    items: Vec<wire::AgendaAttachmentRow>,
    /// The cursor of the next page, as the answer spelled it.
    next: Option<String>,
    read: Loaded,
    waiting: Option<Waiting>,
    /// The attachment whose remove confirm is up.
    removing: Option<String>,
    status: Option<wire::StatusLine>,
}

impl Attachments {
    #[must_use]
    pub fn of(of: Of, item_id: &str) -> Self {
        Self {
            of,
            item_id: item_id.to_owned(),
            ..Self::default()
        }
    }

    fn page(
        &self,
        ctx: &Ctx,
        after: Option<String>,
        limit: usize,
    ) -> Reading<wire::AgendaAttachments> {
        let (item_id, limit) = (
            self.item_id.clone(),
            u32::try_from(limit).unwrap_or(u32::MAX),
        );
        let pick = |answer| match answer {
            Answer::AgendaAttachments(page) => Some(page),
            _ => None,
        };
        match self.of {
            Of::Event => read::read(
                ctx,
                load::calendar::Attachments {
                    item_id,
                    after,
                    limit,
                },
                pick,
            ),
            Of::Task => read::read(
                ctx,
                load::reminders::Attachments {
                    item_id,
                    after,
                    limit,
                },
                pick,
            ),
        }
    }

    /// Read the first page again. A read that failed keeps what is shown: only a first
    /// read that failed has nothing else to draw.
    pub fn reload(&mut self, ctx: &Ctx) {
        let limit = self.items.len().clamp(PAGE, PAGE_MAX);
        match self.page(ctx, None, limit) {
            Reading::Data(page) => {
                self.items = page.attachments;
                self.next = page.next;
                self.read = Loaded::Read;
            }
            Reading::Denied(_) | Reading::Failed => {
                if self.read == Loaded::Unread {
                    self.read = Loaded::Failed;
                }
            }
        }
    }

    fn more(&mut self, ctx: &Ctx) {
        let Some(cursor) = self.next.clone() else {
            return;
        };
        if let Reading::Data(page) = self.page(ctx, Some(cursor), PAGE) {
            for row in page.attachments {
                if !self
                    .items
                    .iter()
                    .any(|have| have.attachment_id == row.attachment_id)
                {
                    self.items.push(row);
                }
            }
            self.next = page.next;
        }
    }

    /// One control of the section. The effects are the shell's work (a picker).
    pub fn event(&mut self, ctx: &Ctx, event: wire::AgendaAttachmentEvent) -> Vec<wire::Effect> {
        match event.kind {
            Some(K::AddPhoto(_)) => return self.add(Pick::Photo),
            Some(K::AddFile(_)) => return self.add(Pick::File),
            Some(K::RemoveAsked(asked)) => {
                if self
                    .items
                    .iter()
                    .any(|row| row.attachment_id == asked.attachment_id)
                {
                    self.removing = Some(asked.attachment_id);
                }
            }
            Some(K::RemoveConfirmed(_)) => self.detach(ctx),
            Some(K::RemoveDismissed(_)) => self.removing = None,
            Some(K::ShowMore(_)) => self.more(ctx),
            Some(K::StatusDismissed(_)) => self.status = None,
            None => {}
        }
        Vec::new()
    }

    fn add(&mut self, pick: Pick) -> Vec<wire::Effect> {
        if self.waiting.is_some() {
            return Vec::new();
        }
        self.status = None;
        self.waiting = Some(Waiting { pick, name: None });
        let kind = match pick {
            Pick::Photo => wire::pick_file::Kind::Photo,
            Pick::File => wire::pick_file::Kind::Upload,
        };
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::PickFile(wire::PickFile {
                kind: kind as i32,
            })),
        }]
    }

    /// The shell's answer to `PickFile`. `None` when no pick is waiting, so the caller can
    /// offer the answer to whoever is.
    pub fn result(&mut self, ctx: &Ctx, outcome: &O) -> Option<Vec<wire::Effect>> {
        let waiting = self.waiting.clone()?;
        match outcome {
            O::FileProgress(progress) => {
                self.waiting = Some(Waiting {
                    name: Some(progress.name.clone()).filter(|name| !name.trim().is_empty()),
                    ..waiting
                });
            }
            O::FilePicked(picked) => {
                self.waiting = None;
                self.attach(ctx, waiting.pick, picked);
                self.reload(ctx);
            }
            // THE MEMBER CLOSED THE PICKER: nothing happened, so nothing is said.
            O::Done(_) => self.waiting = None,
            O::Failed(failed) => {
                self.waiting = None;
                if !failed.cancelled {
                    self.refuse(refusal_of(ctx.locale(), failed));
                }
            }
            _ => return None,
        }
        Some(Vec::new())
    }

    fn refuse(&mut self, sentence: String) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: true,
        });
    }

    /// Make the staged bytes a photo or a document, and attach it.
    fn attach(&mut self, ctx: &Ctx, pick: Pick, picked: &wire::FilePicked) {
        let locale = ctx.locale();
        let media_type = media_type_of(&picked.name, &picked.media_type);
        let size = i64::try_from(picked.byte_size).ok();
        let (made, subject): (wire::ActRequest, &str) = match pick {
            Pick::Photo => (photo_upload(picked, media_type, size).into(), "photo"),
            Pick::File => (
                file_upload(picked, media_type, size, words::attachment_untitled(locale)).into(),
                "document",
            ),
        };
        let key = kit_act::key(&["attach-make", subject, &picked.blob], kit_act::fresh());
        let made = kit_act::act(ctx, made, &key);
        let Some(id) = made.output_text("id").filter(|_| made.committed) else {
            self.refuse(refusal_or(locale, &made.refusal));
            return;
        };
        let key = kit_act::key(
            &[act::calendar::Attach::NAME, &self.item_id, &id],
            kit_act::fresh(),
        );
        let (from, to) = (self.item_id.clone(), id);
        let attached = match self.of {
            Of::Event => kit_act::act(ctx, act::calendar::Attach { from, to }, &key),
            Of::Task => kit_act::act(ctx, act::reminders::Attach { from, to }, &key),
        };
        if !attached.committed {
            self.refuse(refusal_or(locale, &attached.refusal));
        }
    }

    fn detach(&mut self, ctx: &Ctx) {
        let Some(id) = self.removing.take() else {
            return;
        };
        self.status = None;
        let key = kit_act::key(
            &[act::calendar::Detach::NAME, &self.item_id, &id],
            kit_act::fresh(),
        );
        let (from, to) = (self.item_id.clone(), id);
        let detached = match self.of {
            Of::Event => kit_act::act(ctx, act::calendar::Detach { from, to }, &key),
            Of::Task => kit_act::act(ctx, act::reminders::Detach { from, to }, &key),
        };
        if !detached.committed {
            self.refuse(refusal_or(ctx.locale(), &detached.refusal));
        }
        self.reload(ctx);
    }

    /// The section, as a page draws it.
    #[must_use]
    pub fn view(&self, locale: Locale) -> wire::AgendaAttachmentsSection {
        let photos: Vec<String> = self
            .items
            .iter()
            .filter(|row| row.kind == PHOTO)
            .map(|row| row.attachment_id.clone())
            .collect();
        let busy = self.waiting.as_ref();
        wire::AgendaAttachmentsSection {
            heading: if self.items.is_empty() || self.next.is_some() {
                words::attachments_heading(locale)
            } else {
                fill(
                    &words::attachments_heading_counted(locale),
                    &[("count", &self.items.len().to_string())],
                )
            },
            items: self
                .items
                .iter()
                .map(|row| tile(locale, row, &photos))
                .collect(),
            empty_label: if self.read == Loaded::Read && self.items.is_empty() {
                words::attachments_empty(locale)
            } else {
                String::new()
            },
            add_photo_label: words::add_photo_label(locale),
            add_file_label: words::add_file_label(locale),
            has_more: self.next.is_some(),
            more_label: words::attachments_more_label(locale),
            busy: busy.is_some(),
            busy_label: busy.map_or_else(String::new, |waiting| match &waiting.name {
                Some(name) => fill(&words::adding_status(locale), &[("name", name)]),
                None => words::adding_unnamed_status(locale),
            }),
            remove_confirm: self.removing.as_ref().and_then(|id| {
                let row = self.items.iter().find(|row| &row.attachment_id == id)?;
                Some(wire::Confirm {
                    title: words::remove_title(locale),
                    body: if row.kind == PHOTO {
                        words::remove_photo_body(locale)
                    } else {
                        words::remove_file_body(locale)
                    },
                    confirm_label: words::remove_label(locale),
                    destructive: true,
                })
            }),
            status: self.status.clone(),
            add_photo_icon_key: ICON_PHOTO.to_owned(),
            add_file_icon_key: ICON_ADD_FILE.to_owned(),
        }
    }
}

/// The words for an attachment's kind: a photo, or a document by what its bytes are.
fn kind_label(locale: Locale, row: &wire::AgendaAttachmentRow) -> String {
    let media = row.media_type.to_lowercase();
    if row.kind == PHOTO {
        words::attachment_kind_photo(locale)
    } else if media == "application/pdf" {
        words::attachment_kind_pdf(locale)
    } else if media.starts_with("image/") {
        words::attachment_kind_image(locale)
    } else if media.starts_with("text/") {
        words::attachment_kind_text(locale)
    } else {
        words::attachment_kind_file(locale)
    }
}

fn tile(
    locale: Locale,
    row: &wire::AgendaAttachmentRow,
    photos: &[String],
) -> wire::AgendaAttachmentTile {
    let is_photo = row.kind == PHOTO;
    let kind = kind_label(locale, row);
    let title = row
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map_or_else(
            || {
                if is_photo {
                    words::attachment_kind_photo(locale)
                } else {
                    words::attachment_untitled(locale)
                }
            },
            str::to_owned,
        );
    let meta = fill(
        &words::attachment_meta(locale),
        &[("kind", &kind), ("size", &format_byte_size(row.byte_size))],
    );
    // WHERE A TAP GOES is the shell's one table of rows to pages (`row_routes`): this section
    // names no other app's screen. The photographs beside a photo are what its viewer pages through.
    let (app, entity) = if is_photo {
        ("photos", PHOTO)
    } else {
        ("docs", "document")
    };
    let row_ref = RowRef::new(app, entity, &row.attachment_id, &title);
    let beside: Vec<RowRef> = photos
        .iter()
        .map(|id| RowRef::new("photos", PHOTO, id, ""))
        .collect();
    let route = row_routes::route(&row_ref, &agenda_words::app_title(locale), &beside);
    wire::AgendaAttachmentTile {
        attachment_id: row.attachment_id.clone(),
        accessibility_label: fill(
            &words::attachment_spoken(locale),
            &[("name", &title), ("kind", &kind)],
        ),
        remove_accessibility_label: fill(&words::remove_spoken_label(locale), &[("name", &title)]),
        remove_label: words::remove_label(locale),
        kind: row.kind.clone(),
        thumbnail_path: row.thumbnail_path.clone(),
        icon_key: if is_photo { ICON_PHOTO } else { ICON_FILE }.to_owned(),
        badge: if is_photo { String::new() } else { kind },
        route,
        title,
        meta,
    }
}

/// The member's words for a refused add: where to turn a grant on, a phone with no picker, or
/// the file that would not go.
fn refusal_of(locale: Locale, failed: &wire::EffectFailed) -> String {
    if failed.denied {
        words::add_denied_error(locale)
    } else if failed.reason == UNAVAILABLE {
        words::add_unavailable_error(locale)
    } else {
        words::add_failed_error(locale)
    }
}

/// The vault's own sentence for a refusal, or ours when it gave none.
fn refusal_or(locale: Locale, sentence: &str) -> String {
    if sentence.trim().is_empty() {
        words::add_failed_error(locale)
    } else {
        sentence.to_owned()
    }
}

/// The file's name as the origin keeps it, or nothing for a file the platform named none for.
fn arrival_label(name: &str) -> Option<String> {
    Some(name.trim().to_owned()).filter(|name| !name.is_empty())
}

/// The photograph a picked image becomes: it arrived through the picker.
fn photo_upload(
    picked: &wire::FilePicked,
    media_type: String,
    size: Option<i64>,
) -> act::photos::Upload {
    let label = arrival_label(&picked.name);
    act::photos::Upload {
        blob: picked.blob.clone(),
        media_type,
        size,
        arrived_system: label
            .is_some()
            .then_some(act::photos::UploadArrivedSystem::Picker),
        arrived_label: label,
        ..Default::default()
    }
}

/// The document a picked file becomes: it arrived as an upload, under its file name (untitled
/// when the platform named none, and then it names no arrival rather than half of one).
fn file_upload(
    picked: &wire::FilePicked,
    media_type: String,
    size: Option<i64>,
    untitled: String,
) -> act::docs::Upload {
    let label = arrival_label(&picked.name);
    act::docs::Upload {
        blob: picked.blob.clone(),
        media_type,
        title: label.clone().unwrap_or(untitled),
        size,
        arrived_system: label
            .is_some()
            .then_some(act::docs::UploadArrivedSystem::Upload),
        arrived_label: label,
        ..Default::default()
    }
}

/// A media type for a file the platform named none for, off its name: the core has no sniffer,
/// and bytes promoted as `application/octet-stream` are ones no stage will draw.
#[must_use]
pub fn media_type_of(name: &str, stated: &str) -> String {
    if !stated.trim().is_empty() {
        return stated.trim().to_owned();
    }
    let extension = name
        .rsplit_once('.')
        .map_or("", |(_, ext)| ext)
        .to_lowercase();
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
        _ => OCTET_STREAM,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picked(name: &str) -> wire::FilePicked {
        wire::FilePicked {
            blob: "a".repeat(64),
            byte_size: 9,
            name: name.to_owned(),
            media_type: String::new(),
        }
    }

    #[test]
    fn a_picked_photo_arrives_through_the_picker_under_its_file_name() {
        let request: wire::ActRequest =
            photo_upload(&picked(" IMG_0042.jpg "), "image/jpeg".to_owned(), Some(9)).into();
        let text = |key: &str| match &request.input[key].kind {
            Some(wire::value::Kind::Text(text)) => text.clone(),
            other => panic!("{key}: {other:?}"),
        };
        assert_eq!(text("arrived_system"), "picker");
        assert_eq!(text("arrived_label"), "IMG_0042.jpg");
    }

    #[test]
    fn a_picked_file_arrives_as_an_upload_under_its_file_name() {
        let request: wire::ActRequest = file_upload(
            &picked("Lease.pdf"),
            "application/pdf".to_owned(),
            Some(9),
            "Untitled".to_owned(),
        )
        .into();
        let text = |key: &str| match &request.input[key].kind {
            Some(wire::value::Kind::Text(text)) => text.clone(),
            other => panic!("{key}: {other:?}"),
        };
        assert_eq!(text("arrived_system"), "upload");
        assert_eq!(text("arrived_label"), "Lease.pdf");
        assert_eq!(text("title"), "Lease.pdf");
    }

    #[test]
    fn a_picked_photo_with_no_name_says_nothing_rather_than_half_an_arrival() {
        let request: wire::ActRequest =
            photo_upload(&picked("  "), "image/jpeg".to_owned(), None).into();
        assert!(!request.input.contains_key("arrived_system"));
        assert!(!request.input.contains_key("arrived_label"));
    }
}
