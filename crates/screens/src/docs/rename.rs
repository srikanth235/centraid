//! AN INLINE RENAME THAT SAVES AS THE MEMBER TYPES (#1015 D3: autosave
//! everywhere, close = done) — the kit's [`Autosave`] over one title, on the
//! drive's row menu and on a document's page.
//!
//! The draft is the title; the baseline is the title the vault last had. A
//! blank title is refused with a sentence and keeps the words (the command
//! needs one). Closing the field saves what is unsaved and the rename leaves the
//! screen once its last save commits; a refused save keeps the field open with
//! the sentence over the words.

use centraid_api_proto::core_v1 as wire;

use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::autosave::{Autosave, Draft, Resolved};
use crate::kit::read::{self, Reading};
use crate::kit::stale;
use crate::screen::Ctx;
use crate::strings::{Locale, docs as words};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Title {
    document_id: String,
    title: String,
    /// The document's revision when its title was read, advanced by each save's answer: what a
    /// rename names as the one it replaces (#1185). `None` when it could not be read.
    rev: Option<i64>,
}

impl Draft for Title {
    const ACTION: &'static str = act::docs::Rename::NAME;

    fn noun(locale: Locale) -> String {
        crate::strings::chat_confirm::noun_document(locale)
    }

    fn subject(&self) -> &str {
        &self.document_id
    }

    /// A document needs a name: an emptied title is kept on screen and not sent.
    fn refusal(&self, locale: Locale) -> Option<String> {
        self.title
            .trim()
            .is_empty()
            .then(|| words::name_required(locale))
    }

    fn request(&self, baseline: &Self) -> Option<wire::ActRequest> {
        let title = self.title.trim();
        (title != baseline.title.trim()).then(|| {
            act::docs::Rename {
                document_id: self.document_id.clone(),
                title: title.to_owned(),
                expected_rev: self.rev,
            }
            .into()
        })
    }

    fn committed(&mut self, output: &[u8]) {
        if let Some(rev) = serde_json::from_slice::<serde_json::Value>(output)
            .ok()
            .and_then(|value| value.get("rev")?.as_i64())
        {
            self.rev = Some(rev);
        }
    }

    fn subject_id(&self) -> Option<&str> {
        Some(&self.document_id)
    }

    fn base_rev(&self) -> Option<i64> {
        self.rev
    }

    fn rebased(&mut self, rev: i64) {
        self.rev = Some(rev);
    }

    fn kept_fields(&self, baseline: &Self) -> Vec<(String, serde_json::Value)> {
        if self.title.trim() == baseline.title.trim() {
            return Vec::new();
        }
        vec![("entity.title".to_owned(), self.title.trim().into())]
    }
}

/// One open rename.
#[derive(Debug)]
pub struct Rename {
    document_id: String,
    autosave: Autosave<Title>,
    /// After Reload: where the member's words went.
    kept: String,
}

/// The document's title and revision, as the vault holds them now: `None` when it cannot be read
/// or is not there to rename.
fn read_title(ctx: &Ctx, document_id: &str) -> Option<(String, i64)> {
    match read::read(
        ctx,
        load::docs::History {
            document_id: document_id.to_owned(),
        },
        |answer| match answer {
            Answer::DocsDocument(document) => Some(document),
            _ => None,
        },
    ) {
        Reading::Data(document) => document
            .document
            .filter(|row| !row.trashed)
            .map(|row| (row.title, document.rev)),
        _ => None,
    }
}

impl Rename {
    /// Open on `document_id`, whose title the vault holds as `title`, and whose revision is read
    /// now: the rename names it when it saves (#1185).
    #[must_use]
    pub fn open(ctx: &Ctx, document_id: &str, title: &str) -> Self {
        let mut autosave = Autosave::new();
        autosave.loaded(Title {
            document_id: document_id.to_owned(),
            title: title.to_owned(),
            rev: read_title(ctx, document_id).map(|(_, rev)| rev),
        });
        Self {
            document_id: document_id.to_owned(),
            autosave,
            kept: String::new(),
        }
    }

    /// Whether the vault refused the rename because the document changed, or went to the trash,
    /// since the field opened.
    #[must_use]
    pub fn conflicted(&self) -> bool {
        self.autosave.conflict().is_some()
    }

    /// RELOAD after a conflict: the title typed is kept as an earlier version, then the field
    /// shows the vault's title. Returns whether the rename is still open (a document that went to
    /// the trash has nothing to rename: the page shows it as it is).
    #[must_use]
    pub fn reload(&mut self, ctx: &Ctx) -> bool {
        let Resolved::Reloaded { kept, .. } = self.autosave.resolve(ctx) else {
            return true;
        };
        let Some((title, rev)) = read_title(ctx, &self.document_id) else {
            return false;
        };
        self.autosave.loaded(Title {
            document_id: self.document_id.clone(),
            title,
            rev: Some(rev),
        });
        if kept {
            self.kept = stale::kept(ctx.locale());
        }
        true
    }

    #[must_use]
    pub fn document_id(&self) -> &str {
        &self.document_id
    }

    /// The words as typed.
    #[must_use]
    pub fn title(&self) -> &str {
        self.autosave
            .draft()
            .map_or("", |draft| draft.title.as_str())
    }

    /// Typing: dirty, with a debounce.
    pub fn edit(&mut self, ctx: &Ctx, title: String) {
        self.autosave.edit(ctx, |draft| draft.title = title);
    }

    /// The debounce came due.
    pub fn fired(&mut self, ctx: &Ctx, timer: &str) {
        let _ = self.autosave.fired(ctx, timer);
    }

    /// Done, or focus left the field: save now. Returns whether the rename is
    /// over (saved, or a blank name walked away from: the vault's title stands
    /// and nothing is sent); a refusal keeps it open.
    #[must_use]
    pub fn close(&mut self, ctx: &Ctx) -> bool {
        if self.title().trim().is_empty() {
            return true;
        }
        let _ = self.autosave.flush(ctx);
        self.autosave.saved()
    }

    /// The view: the title as typed, the autosave line and its words.
    #[must_use]
    pub fn view(&self, locale: Locale) -> wire::DocsRename {
        let autosave = self.autosave.view(locale);
        wire::DocsRename {
            document_id: self.document_id.clone(),
            title: self.title().to_owned(),
            status_label: if self.kept.is_empty() {
                status(&autosave)
            } else {
                self.kept.clone()
            },
            autosave: Some(autosave),
        }
    }
}

/// "Saving", "Saved", the refusal's sentence, or empty while clean.
fn status(autosave: &wire::Autosave) -> String {
    use wire::autosave::Phase;
    match autosave.phase() {
        Phase::Dirty | Phase::Saving | Phase::Saved | Phase::Refused | Phase::Conflict => {
            autosave.label.clone()
        }
        _ => String::new(),
    }
}
