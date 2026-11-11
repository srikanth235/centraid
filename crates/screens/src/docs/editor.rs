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

use super::fold;
use crate::catalog::{act, load};
use crate::kit::autosave::{Autosave, Draft, Resolved};
use crate::kit::read::{self, Reading};
use crate::kit::stale;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, docs as words};

/// The words a member types in the editor: the title and the body.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Typed {
    id: String,
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
        &self.id
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
        let title = self.title.trim() != baseline.title.trim();
        if !title && self.body == baseline.body {
            return None;
        }
        Some(
            act::docs::Edit {
                document_id: self.id.clone(),
                body_text: Some(self.body.clone()),
                title: title.then(|| self.title.trim().to_owned()),
                expected_rev: Some(self.rev),
            }
            .into(),
        )
    }

    fn committed(&mut self, output: &[u8]) {
        if let Some(rev) = serde_json::from_slice::<serde_json::Value>(output)
            .ok()
            .and_then(|value| value.get("rev")?.as_i64())
        {
            self.rev = rev;
        }
    }

    fn subject_id(&self) -> Option<&str> {
        Some(&self.id)
    }

    fn base_rev(&self) -> Option<i64> {
        Some(self.rev)
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

enum Opened {
    Loading,
    Failed,
    /// The document cannot be edited here, and why.
    Refused(String),
    Ready,
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::DocsEditor(args)) = &route.args else {
        return None;
    };
    if args.document_id.is_empty() {
        return None;
    }
    Some(Box::new(Editor {
        document_id: args.document_id.clone(),
        title_hint: args.title.clone(),
        opened: Opened::Loading,
        autosave: Autosave::new(),
        version_label: String::new(),
        format: wire::docs_reader::Format::Plain,
        kept: String::new(),
        remedy: String::new(),
    }))
}

struct Editor {
    document_id: String,
    title_hint: String,
    opened: Opened,
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
            match self.opened {
                Opened::Refused(_) => self.remedy = stale::kept_in_trash(locale),
                _ => self.kept = stale::kept(locale),
            }
        }
    }

    fn reload(&mut self, ctx: &Ctx) {
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
                    self.opened = Opened::Ready;
                    // Over unsaved words the law replaces nothing.
                    self.autosave.loaded(Typed {
                        id: self.document_id.clone(),
                        title: draft.title,
                        body: draft.body,
                        rev: document.rev,
                    });
                }
                Err(sentence) => self.opened = Opened::Refused(sentence),
            },
            Reading::Denied(_) | Reading::Failed => self.opened = Opened::Failed,
        }
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
        let content = match (&self.opened, self.autosave.draft()) {
            (Opened::Loading, _) => Content::Loading(wire::Loading { first_load: true }),
            (Opened::Failed, _) => Content::Failure(read::failure(locale)),
            (Opened::Refused(sentence), _) => Content::Failure(wire::Failure {
                sentence: sentence.clone(),
                remedy: self.remedy.clone(),
            }),
            (Opened::Ready, Some(draft)) => Content::Draft(wire::DocsEditorDraft {
                title: draft.title.clone(),
                body: draft.body.clone(),
            }),
            (Opened::Ready, None) => Content::Loading(wire::Loading { first_load: true }),
        };
        let status_label = match autosave.phase() {
            Save::Dirty | Save::Saving | Save::Saved | Save::Refused | Save::Conflict => {
                autosave.label.clone()
            }
            _ => String::new(),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::DocsEditor(wire::DocsEditorState {
                document_id: self.document_id.clone(),
                title_hint: self.title_hint.clone(),
                content: Some(content),
                version_label: self.version_label.clone(),
                status_label,
                remote_note: if !self.kept.is_empty() {
                    self.kept.clone()
                } else if autosave.remote_changed {
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
                autosave: Some(autosave),
            })),
            ..wire::ViewState::default()
        }
    }
}
