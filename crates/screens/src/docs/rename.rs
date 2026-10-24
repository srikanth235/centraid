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

use crate::catalog::act;
use crate::kit::autosave::{Autosave, Draft};
use crate::screen::Ctx;
use crate::strings::{Locale, docs as words};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Title {
    document_id: String,
    title: String,
}

impl Draft for Title {
    const ACTION: &'static str = act::docs::Rename::NAME;

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
            }
            .into()
        })
    }
}

/// One open rename.
#[derive(Debug)]
pub struct Rename {
    document_id: String,
    autosave: Autosave<Title>,
}

impl Rename {
    /// Open on `document_id`, whose title the vault holds as `title`.
    #[must_use]
    pub fn open(document_id: &str, title: &str) -> Self {
        let mut autosave = Autosave::new();
        autosave.loaded(Title {
            document_id: document_id.to_owned(),
            title: title.to_owned(),
        });
        Self {
            document_id: document_id.to_owned(),
            autosave,
        }
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
            status_label: status(&autosave),
            autosave: Some(autosave),
        }
    }
}

/// "Saving", "Saved", the refusal's sentence, or empty while clean.
fn status(autosave: &wire::Autosave) -> String {
    use wire::autosave::Phase;
    match autosave.phase() {
        Phase::Dirty | Phase::Saving | Phase::Saved | Phase::Refused => autosave.label.clone(),
        _ => String::new(),
    }
}
