//! A TEXT DOCUMENT'S EDITOR (`docs.editor`; #1015 D3: autosave everywhere,
//! close = done).
//!
//! The kit's [`Autosave`] over the title and the body: an edit saves 900 ms
//! later, leaving saves whatever is unsaved, a refused save keeps the words with
//! the sentence over them, and a change from the vault never replaces words being
//! typed. Each save is ONE `edit`, which mints a new version — the body always
//! whole, the title only when it changed. Only a live text document whose text
//! this vault holds opens here; anything else says why.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::autosave::Phase as Save;
use wire::docs_editor_event::Kind as D;
use wire::screen_event::Kind as E;

use super::{denied, fold};
use crate::catalog::{act, load};
use crate::kit::autosave::{Autosave, Draft, Resolved};
use crate::kit::read::{self, Note, Page, Reading};
use crate::kit::stale;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, docs as words};

/// The words a member types in the editor: the title and the body.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Typed {
    /// `None` for a new document nothing has made yet: its first save is a create.
    id: Option<String>,
    /// A new document's folder (`None` is the root).
    folder_id: Option<String>,
    title: String,
    body: String,
    /// The document's revision when it was read, advanced by each save's answer: what a save
    /// names as the one it replaces (#1185).
    rev: i64,
}

impl Draft for Typed {
    const ACTION: &'static str = act::docs::Edit::NAME;

    fn noun(locale: Locale) -> String {
        crate::strings::chat_confirm::noun_document(locale)
    }

    fn subject(&self) -> &str {
        self.id.as_deref().unwrap_or("new")
    }

    /// A document needs a name: an emptied title is kept on screen and not sent.
    fn refusal(&self, locale: Locale) -> Option<String> {
        self.title
            .trim()
            .is_empty()
            .then(|| words::name_required(locale))
    }

    /// `edit`: the words go whole in `body_text` (each save is a new version),
    /// and `title` only when it changed.
    fn request(&self, baseline: &Self) -> Option<wire::ActRequest> {
        let Some(id) = &self.id else {
            // A NEW DOCUMENT: nothing typed, nothing made. The first words create it.
            if self.title == baseline.title && self.body == baseline.body {
                return None;
            }
            return Some(
                act::docs::CreateText {
                    title: self.title.trim().to_owned(),
                    body_text: Some(self.body.clone()),
                    folder_id: self.folder_id.clone(),
                    ..Default::default()
                }
                .into(),
            );
        };
        let title = self.title.trim() != baseline.title.trim();
        if !title && self.body == baseline.body {
            return None;
        }
        Some(
            act::docs::Edit {
                document_id: id.clone(),
                body_text: Some(self.body.clone()),
                title: title.then(|| self.title.trim().to_owned()),
                expected_rev: Some(self.rev),
            }
            .into(),
        )
    }

    fn committed(&mut self, output: &[u8]) {
        let value = serde_json::from_slice::<serde_json::Value>(output).ok();
        if self.id.is_none() {
            // The create answers the new document's id: this is an edit of it from now on.
            self.id = value
                .as_ref()
                .and_then(|value| value.get("id")?.as_str().map(str::to_owned));
        } else if let Some(rev) = value.as_ref().and_then(|value| value.get("rev")?.as_i64()) {
            self.rev = rev;
        }
    }

    fn subject_id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    fn base_rev(&self) -> Option<i64> {
        self.id.as_ref().map(|_| self.rev)
    }

    fn rebased(&mut self, rev: i64) {
        self.rev = rev;
    }

    /// The words the document does not hold, by the vault's names for them: the text is the
    /// document's own words (it keeps them as the bytes of a version).
    fn kept_fields(&self, baseline: &Self) -> Vec<(String, serde_json::Value)> {
        let mut kept = Vec::new();
        if self.title.trim() != baseline.title.trim() {
            kept.push(("entity.title".to_owned(), self.title.trim().into()));
        }
        if self.body != baseline.body {
            kept.push(("document.text".to_owned(), self.body.clone().into()));
        }
        kept
    }
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::DocsEditor(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Editor {
        document_id: args.document_id.clone(),
        new_folder: Some(args.folder_id.clone()).filter(|_| args.document_id.is_empty()),
        title_hint: args.title.clone(),
        page: Page::loading(),
        refusal: None,
        autosave: Autosave::new(),
        version_label: String::new(),
        format: wire::docs_reader::Format::Plain,
        kept: String::new(),
        remedy: String::new(),
    }))
}

struct Editor {
    /// Empty for a new document until its first autosave creates it.
    document_id: String,
    /// A NEW document's folder ("" the root); `None` for one that exists.
    new_folder: Option<String>,
    title_hint: String,
    /// The read of the document: the gate, a failure, or ready (with the words typed).
    page: Page<()>,
    /// Why the document cannot be edited here, when it cannot (a final failure in its own words).
    refusal: Option<String>,
    /// The vault would not let Docs read: the page is the gate (it never retries by itself).
    autosave: Autosave<Typed>,
    /// "Version 4" — the vault's, re-read after a save commits.
    version_label: String,
    format: wire::docs_reader::Format,
    /// After Reload: where the member's words went, said where the version is.
    kept: String,
    /// After Reload over a document in the trash: how to find the words, said under the sentence.
    remedy: String,
}

impl Editor {
    /// RELOAD after a save the vault refused as stale (#1185): the words typed are kept as an
    /// earlier version of the document, then the vault's document is read and shown.
    fn reload_after_conflict(&mut self, ctx: &Ctx) {
        let locale = ctx.locale();
        let Resolved::Reloaded { kept, .. } = self.autosave.resolve(ctx) else {
            return;
        };
        self.reload(ctx);
        if kept {
            if self.refusal.is_some() {
                self.remedy = stale::kept_in_trash(locale);
            } else {
                self.kept = stale::kept(locale);
            }
        }
    }

    /// A NEW DOCUMENT opens on an empty draft (its title as the Add sheet named it) and is not
    /// read: nothing is in the vault under it yet. The first autosave creates it.
    fn open_new(&mut self) {
        if self.autosave.draft().is_some() {
            return;
        }
        let folder = self.new_folder.clone().filter(|id| !id.is_empty());
        self.page = Page::Ready {
            data: (),
            note: None,
        };
        self.autosave.loaded(Typed {
            id: None,
            folder_id: folder,
            title: self.title_hint.clone(),
            body: String::new(),
            rev: 0,
        });
    }

    /// The save that created the document named it: the editor is its editor from now on.
    fn adopt_created(&mut self, ctx: &Ctx) {
        if !self.document_id.is_empty() {
            return;
        }
        let Some(id) = self.autosave.draft().and_then(|draft| draft.id.clone()) else {
            return;
        };
        self.document_id = id;
        self.new_folder = None;
        // The words on screen are the only copy of what is typed since; the read only takes
        // the vault's revision (and the version label).
        self.reload(ctx);
    }

    fn reload(&mut self, ctx: &Ctx) {
        if self.document_id.is_empty() {
            self.open_new();
            return;
        }
        let reading = read::read(
            ctx,
            load::docs::History {
                document_id: self.document_id.clone(),
            },
            |answer| match answer {
                Answer::DocsDocument(document) => Some(document),
                _ => None,
            },
        );
        match reading {
            Reading::Data(document) => match fold::editor(ctx.locale(), &document) {
                // Words not yet saved are the only copy: a document trashed elsewhere does not
                // replace the editor under them. The save is refused as stale and Reload keeps them.
                Err(_) if self.autosave.unsaved() => self.autosave.vault_moved(),
                Ok(draft) => {
                    self.kept.clear();
                    self.remedy.clear();
                    self.version_label = draft.version_label;
                    self.format = draft.format;
                    self.refusal = None;
                    self.page = Page::Ready {
                        data: (),
                        note: None,
                    };
                    // Over unsaved words the law replaces nothing.
                    self.autosave.loaded(Typed {
                        id: Some(self.document_id.clone()),
                        folder_id: None,
                        title: draft.title,
                        body: draft.body,
                        rev: document.rev,
                    });
                }
                Err(sentence) => {
                    self.refusal = Some(sentence);
                    self.page = Page::Failed;
                }
            },
            Reading::Denied(denial) => self.page = Page::Refused(denial),
            // A re-read that failed keeps the words typed under one sentence; a first read has
            // nothing else to show.
            Reading::Failed => {
                if self.autosave.draft().is_some() {
                    let kept = std::mem::replace(&mut self.page, Page::loading());
                    self.page = kept.noted(Some(Note::refresh_failed(ctx.locale())));
                } else {
                    self.page = Page::Failed;
                }
            }
        }
    }

    /// THE DOCUMENT'S READ (#1185): a gate (never retried by itself), a document that cannot be
    /// edited here or could not be read (nothing is shown), the words with a note over them when a
    /// re-read failed, or the first load.
    fn page(&self) -> Page<()> {
        // Ready with no draft yet is still the first load.
        if matches!(self.page, Page::Ready { .. }) && self.autosave.draft().is_none() {
            return Page::loading();
        }
        self.page.clone()
    }
}

impl Screen for Editor {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::TimerFired(fired)) => {
                if self.autosave.fired(ctx, &fired.timer) {
                    self.reload(ctx);
                }
                self.adopt_created(ctx);
            }
            Some(E::StatusActed(_)) => self.reload_after_conflict(ctx),
            // CLOSE = DONE: whatever is typed is saved.
            Some(E::Left(_)) => {
                let _ = self.autosave.flush(ctx);
            }
            Some(E::DocsEditor(event)) => match event.kind {
                Some(D::Refreshed(_)) => self.reload(ctx),
                Some(D::Title(typed)) => self.autosave.edit(ctx, |draft| draft.title = typed.title),
                Some(D::Body(typed)) => self.autosave.edit(ctx, |draft| draft.body = typed.body),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::docs_editor_state::Content;
        let locale = ctx.locale();
        let autosave = self.autosave.view(locale);
        let page = self.page();
        let ready = matches!(page, Page::Ready { .. });
        let mut wired = page.wire(
            locale,
            |denial| denied(locale, denial),
            wire::EmptyState::default,
        );
        // A document that cannot be edited here says why in its own words.
        if let (Some(sentence), Some(wire::page_state::State::Failed(_))) =
            (&self.refusal, &wired.state)
        {
            wired.state = Some(wire::page_state::State::Failed(read::gone(
                sentence.clone(),
                self.remedy.clone(),
            )));
        }
        let content = self.autosave.draft().filter(|_| ready).map(|draft| {
            Content::Draft(wire::DocsEditorDraft {
                title: draft.title.clone(),
                body: draft.body.clone(),
            })
        });
        // A failed/gated page has no editable draft and cannot claim a save.
        let autosave = content.as_ref().map(|_| autosave);
        let status_label = match autosave.as_ref().map(wire::Autosave::phase) {
            Some(Save::Dirty | Save::Saving | Save::Saved | Save::Refused | Save::Conflict) => {
                autosave
                    .as_ref()
                    .expect("a save phase has a status")
                    .label
                    .clone()
            }
            _ => String::new(),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::DocsEditor(wire::DocsEditorState {
                document_id: self.document_id.clone(),
                title_hint: self.title_hint.clone(),
                content,
                page: Some(wired),
                version_label: self.version_label.clone(),
                status_label,
                remote_note: if !self.kept.is_empty() {
                    self.kept.clone()
                } else if autosave.as_ref().is_some_and(|save| save.remote_changed) {
                    words::remote_changed(locale)
                } else {
                    String::new()
                },
                format: self.format as i32,
                chrome: Some(wire::DocsEditorChrome {
                    done: words::done(locale),
                    title_placeholder: words::editor_title_placeholder(locale),
                    body_placeholder: words::editor_body_placeholder(locale),
                    loading: words::loading(locale),
                    retry: words::retry(locale),
                }),
                autosave,
            })),
            ..wire::ViewState::default()
        }
    }
}
