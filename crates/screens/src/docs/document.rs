//! ONE DOCUMENT (`docs.document`, #1046): a pushed page (#1015 D4: content
//! pushes).
//!
//! The core says which surface opens it — the reader over the decoded text, the
//! media stage over the bytes (or why they are not on this device), or the facts
//! for a kind the phone cannot render — and this draws that with the facts under
//! it. Its version history is a page of its own
//! (`docs.versions`), reached by a row. The head's writes are the drive row's
//! (star, rename inline, move, labels, trash behind a confirm), plus restore and
//! Delete forever on a trashed document.
//!
//! It reads `docs.history` (the document, its path, its versions and its text),
//! and `docs.drive` at its smallest window for the folders and labels the Move
//! and Labels sheets list. Editing the text is `docs.editor`,
//! the Edit action's route.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::docs_document_event::Kind as D;
use wire::docs_document_state::Asking;
use wire::screen_event::Kind as E;

use super::fold::{self, KEY_LABELS, KEY_MORE, KEY_MOVE, KEY_PURGE, KEY_RENAME, KEY_RESTORE};
use super::fold::{KEY_STAR, KEY_TRASH, KEY_UNSTAR};
use super::folders::{self, TOP_LEVEL};
use super::rename::Rename;
use super::{Phase, denied, refusal};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, docs as words, shared};

/// `docs.drive`'s smallest window: the rail is whole whatever the window.
const RAIL_WINDOW: u32 = 20;

/// What the page holds of its reads.
#[derive(Clone, Debug)]
struct Answered {
    document: wire::DocsDocument,
    drive: Option<wire::DocsDrive>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Sheet {
    None,
    More,
    Move,
    Labels(String),
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::DocsDocument(args)) = &route.args else {
        return None;
    };
    if args.document_id.is_empty() {
        return None;
    }
    Some(Box::new(Document {
        document_id: args.document_id.clone(),
        title_hint: args.title.clone(),
        parent: args.parent.clone(),
        phase: Phase::Loading,
        status: None,
        asking: Asking::None,
        sheet: Sheet::None,
        rename: None,
        dismissed: false,
    }))
}

struct Document {
    document_id: String,
    /// Rides along, so the head has words before the read.
    title_hint: String,
    /// The page it was pushed from, by its title: what the back control says.
    parent: String,
    phase: Phase<Answered>,
    status: Option<wire::StatusLine>,
    asking: Asking,
    sheet: Sheet,
    rename: Option<Rename>,
    /// The document was deleted forever here: the shell pops.
    dismissed: bool,
}

impl Document {
    fn reload(&mut self, ctx: &Ctx) {
        let document = read::read(
            ctx,
            load::docs::History {
                document_id: self.document_id.clone(),
            },
            |answer| match answer {
                Answer::DocsDocument(document) => Some(document),
                _ => None,
            },
        );
        // The secondary reads decorate the page: one that does not land leaves
        // its part out (no folders to move to).
        let drive = read::read(
            ctx,
            load::docs::Drive {
                shelf: Some("starred".to_owned()),
                limit: RAIL_WINDOW,
                ..Default::default()
            },
            |answer| match answer {
                Answer::DocsDrive(drive) => Some(drive),
                _ => None,
            },
        );
        self.phase = match document {
            Reading::Data(document) => Phase::Ready(Answered {
                document,
                drive: match drive {
                    Reading::Data(drive) => Some(drive),
                    _ => None,
                },
            }),
            Reading::Denied(denial) => Phase::Denied(denial),
            Reading::Failed => Phase::Failed,
        };
    }

    fn row(&self) -> Option<&wire::DocsDocumentRow> {
        self.phase.data()?.document.document.as_ref()
    }

    fn write(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>) -> bool {
        let request: wire::ActRequest = request.into();
        self.status = None;
        let key = kit_act::key(&[&request.action, &self.document_id], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            self.status = Some(refusal(settled.refusal));
        }
        self.reload(ctx);
        settled.committed
    }

    fn action(&mut self, ctx: &Ctx, key: &str) {
        let Some(row) = self.row().cloned() else {
            return;
        };
        // Only what the head offers is done: a key for a verb this document
        // does not have (restore on a live one, trash on a trashed one) is nothing.
        let offered = fold::head_actions(ctx.locale(), &row)
            .into_iter()
            .any(|action| action.key == key && action.enabled);
        if !offered {
            return;
        }
        let id = row.document_id.clone();
        match key {
            KEY_STAR => {
                self.write(ctx, act::docs::Star { document_id: id });
            }
            KEY_UNSTAR => {
                self.write(ctx, act::docs::Unstar { document_id: id });
            }
            KEY_RESTORE => {
                self.write(ctx, act::docs::Restore { document_id: id });
            }
            KEY_RENAME => {
                if self.rename.is_some() {
                    self.close_rename(ctx);
                    if self.rename.is_some() {
                        return;
                    }
                }
                self.rename = Some(Rename::open(&id, &row.title));
            }
            KEY_MOVE => self.sheet = Sheet::Move,
            KEY_LABELS => self.sheet = Sheet::Labels(String::new()),
            KEY_TRASH => self.asking = Asking::Trash,
            KEY_PURGE => self.asking = Asking::Purge,
            // `edit` is a route the shell pushes (the action carries it).
            _ => {}
        }
    }

    fn choice(&mut self, ctx: &Ctx, key: &str) {
        if self.sheet != Sheet::Move {
            return;
        }
        self.sheet = Sheet::None;
        let Some(row) = self.row().cloned() else {
            return;
        };
        let folder_id = if key == TOP_LEVEL { "" } else { key };
        if folder_id == row.folder_id {
            return;
        }
        self.write(
            ctx,
            act::docs::Move {
                document_id: row.document_id,
                folder_id: Some(folder_id.to_owned()).filter(|id| !id.is_empty()),
            },
        );
    }

    fn label_added(&mut self, ctx: &Ctx, raw: &str) {
        let Some(row) = self.row().cloned() else {
            return;
        };
        let label = raw.trim().to_owned();
        if let Sheet::Labels(draft) = &mut self.sheet {
            draft.clear();
        }
        if label.is_empty() || row.labels.iter().any(|chip| chip.label == label) {
            return;
        }
        self.write(
            ctx,
            act::docs::Tag {
                document_id: row.document_id,
                label,
            },
        );
    }

    fn label_removed(&mut self, ctx: &Ctx, tag_id: &str) {
        let Some(row) = self.row().cloned() else {
            return;
        };
        // The vault removes a label by its words: the row's label this tag stands for.
        let Some(label) = row
            .labels
            .iter()
            .find(|chip| chip.tag_id == tag_id)
            .map(|chip| chip.label.clone())
        else {
            return;
        };
        self.write(
            ctx,
            act::docs::Untag {
                document_id: row.document_id,
                label,
            },
        );
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        let asking = std::mem::replace(&mut self.asking, Asking::None);
        let id = self.document_id.clone();
        match asking {
            Asking::Trash => {
                self.write(ctx, act::docs::Trash { document_id: id });
            }
            Asking::Purge => {
                // DELETED FOREVER: nothing is left to show, so the page leaves.
                if self.write(ctx, act::docs::Purge { document_id: id }) {
                    self.dismissed = true;
                    self.rename = None;
                }
            }
            _ => {}
        }
    }

    fn close_rename(&mut self, ctx: &Ctx) {
        if self.rename.as_mut().is_some_and(|rename| rename.close(ctx)) {
            self.rename = None;
            self.reload(ctx);
        }
    }

    fn event(&mut self, event: wire::DocsDocumentEvent, ctx: &Ctx) {
        match event.kind {
            Some(D::Refreshed(_)) => self.reload(ctx),
            // THE VERBS SHEET: every verb the head offers, as a list.
            Some(D::MoreOpened(_)) => {
                if self.row().is_some() {
                    self.sheet = Sheet::More;
                }
            }
            Some(D::Action(picked)) => {
                // A verb picked from the sheet closes it.
                if self.sheet == Sheet::More {
                    self.sheet = Sheet::None;
                }
                if picked.key == KEY_MORE {
                    if self.row().is_some() {
                        self.sheet = Sheet::More;
                    }
                } else {
                    self.action(ctx, &picked.key);
                }
            }
            Some(D::Choice(picked)) => self.choice(ctx, &picked.key),
            Some(D::SheetClosed(_)) => self.sheet = Sheet::None,
            Some(D::RenameEdited(edited)) => {
                if let Some(rename) = self.rename.as_mut() {
                    rename.edit(ctx, edited.title);
                }
            }
            Some(D::RenameClosed(_)) => self.close_rename(ctx),
            Some(D::LabelAdded(added)) => self.label_added(ctx, &added.label),
            Some(D::LabelRemoved(removed)) => self.label_removed(ctx, &removed.tag_id),
            Some(D::LabelDraft(typed)) => {
                if let Sheet::Labels(draft) = &mut self.sheet {
                    *draft = typed.text;
                }
            }
            Some(D::Confirmed(_)) => self.confirmed(ctx),
            Some(D::Dismissed(_)) => self.asking = Asking::None,
            None => {}
        }
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        match self.asking {
            Asking::Trash => Some(wire::Confirm {
                title: words::trash_confirm_title(locale),
                body: words::trash_confirm_body(locale),
                confirm_label: words::trash_confirm(locale),
                destructive: true,
            }),
            // The trash shelf's own sentences (the kit's), for one document.
            Asking::Purge => Some(wire::Confirm {
                title: shared::trash_purge_title(locale),
                body: shared::trash_purge_body(locale),
                confirm_label: shared::trash_purge(locale),
                destructive: true,
            }),
            _ => None,
        }
    }

    fn sheet_view(&self, locale: Locale, answered: &Answered) -> wire::DocsSheet {
        use wire::docs_sheet::{Body, Kind};
        let none = wire::DocsSheet {
            kind: Kind::None as i32,
            ..wire::DocsSheet::default()
        };
        let Some(row) = answered.document.document.as_ref() else {
            return none;
        };
        let rail_folders = answered
            .drive
            .as_ref()
            .map(|drive| drive.folders.as_slice())
            .unwrap_or_default();
        let rail_labels = answered
            .drive
            .as_ref()
            .map(|drive| drive.labels.as_slice())
            .unwrap_or_default();
        let (kind, title, body) = match &self.sheet {
            Sheet::None => return none,
            Sheet::Move => (
                Kind::Move,
                words::move_title(locale),
                Body::Choices(wire::DocsChoiceList {
                    choices: folders::move_choices(locale, rail_folders, &row.folder_id),
                }),
            ),
            Sheet::Labels(draft) => (
                Kind::Labels,
                words::labels_title(locale),
                Body::Labels(fold::labels_sheet(locale, row, rail_labels, draft)),
            ),
            Sheet::More => (
                Kind::More,
                row.title.clone(),
                Body::Actions(wire::DocsActionList {
                    actions: fold::head_actions(locale, row),
                    footer: String::new(),
                }),
            ),
        };
        wire::DocsSheet {
            kind: kind as i32,
            title,
            document_id: row.document_id.clone(),
            close_label: words::close(locale),
            body: Some(body),
        }
    }

    fn chrome(&self, locale: Locale) -> wire::DocsDocumentChrome {
        wire::DocsDocumentChrome {
            // THE PARENT BY NAME (#1047): the page it was pushed from, else the app.
            back: if self.parent.is_empty() {
                words::app_title(locale)
            } else {
                self.parent.clone()
            },
            retry: words::retry(locale),
            loading: words::loading(locale),
            more: words::more(locale),
            versions_heading: words::versions_heading(locale),
            facts_heading: words::details_heading(locale),
            rename_placeholder: words::rename_placeholder(locale),
            rename_done: words::done(locale),
        }
    }
}

impl Screen for Document {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::TimerFired(fired)) => {
                if let Some(rename) = self.rename.as_mut() {
                    rename.fired(ctx, &fired.timer);
                }
            }
            // CLOSE = DONE: whatever is typed is saved.
            Some(E::Left(_)) => {
                if let Some(rename) = self.rename.as_mut() {
                    let _ = rename.close(ctx);
                }
            }
            Some(E::DocsDocument(event)) => self.event(event, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::docs_document_state::Content;
        let locale = ctx.locale();
        let (content, sheet) = match &self.phase {
            Phase::Loading => (Content::Loading(wire::Loading { first_load: true }), None),
            Phase::Failed => (Content::Failure(read::failure(locale)), None),
            Phase::Denied(denial) => (Content::Denied(denied(locale, denial)), None),
            Phase::Ready(answered) => {
                let mut data = fold::document(
                    locale,
                    &answered.document,
                    answered.drive.as_ref(),
                );
                // The title being typed is the title drawn.
                if let (Some(rename), Some(row)) = (self.rename.as_ref(), data.row.as_mut())
                    && rename.document_id() == row.document_id
                {
                    row.title = rename.title().to_owned();
                }
                (
                    Content::Data(Box::new(data)),
                    Some(self.sheet_view(locale, answered)),
                )
            }
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::DocsDocument(
                wire::DocsDocumentState {
                    document_id: self.document_id.clone(),
                    title_hint: self.title_hint.clone(),
                    content: Some(content),
                    status: self.status.clone(),
                    confirm: self.confirm(locale),
                    rename: self.rename.as_ref().map(|rename| rename.view(locale)),
                    sheet,
                    chrome: Some(self.chrome(locale)),
                    asking: self.asking as i32,
                    dismissed: self.dismissed,
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
