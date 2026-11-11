//! ONE DOCUMENT (`docs.document`, #1046): a pushed page (#1015 D4: content
//! pushes).
//!
//! The core says which surface opens it — the reader over the decoded text, the
//! media stage over the bytes (or why they are not on this device), or the facts
//! for a kind the phone cannot render — and this draws that with the facts under
//! it. Its earlier versions are the kit's one screen
//! (`docs.earlier`), reached by the row at its foot. The head's writes are the drive row's
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
use super::fold::{KEY_SHARE, KEY_STAR, KEY_TRASH, KEY_UNSTAR};
use super::folders::{self, TOP_LEVEL};
use super::rename::Rename;
use super::{Phase, denied};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::earlier;
use crate::kit::follow::{self, Source};
use crate::kit::links::{self, Kind, Links, Outcome};
use crate::kit::owner::{Answer as Owner, Leaving, NoPasscode, OwnerGate};
use crate::kit::read::{self, Reading};
use crate::kit::trash;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, docs as words, links as link_words, shared};

/// `docs.drive`'s smallest window: the rail is whole whatever the window.
const RAIL_WINDOW: u32 = 20;

/// What the page holds of its reads.
#[derive(Clone, Debug)]
struct Answered {
    document: wire::DocsDocument,
    drive: Option<wire::DocsDrive>,
    /// The people the document is about (`people.links`); a read that does not land leaves the
    /// section out rather than the page.
    about: Option<Vec<wire::PeopleLinked>>,
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
        undo: Undo::default(),
        gate: OwnerGate::default(),
        asking: Asking::None,
        sheet: Sheet::None,
        rename: None,
        dismissed: false,
        links: Links::new(&[Kind::Person]),
        differences: follow::Phone::default(),
        earlier: earlier::Foot::default(),
    }))
}

struct Document {
    document_id: String,
    /// Rides along, so the head has words before the read.
    title_hint: String,
    /// The page it was pushed from, by its title: what the back control says.
    parent: String,
    phase: Phase<Answered>,
    /// The status line and what its Undo reverses (the kit's one door).
    undo: Undo,
    /// The owner check a share asks first; a phone with no passcode warns and goes ahead.
    gate: OwnerGate,
    asking: Asking,
    sheet: Sheet,
    rename: Option<Rename>,
    /// The document was deleted forever here: the shell pops.
    dismissed: bool,
    /// The About section's picker (#1173).
    links: Links,
    /// Where the followed folder's name for the document differs from the member's (#1183), read
    /// with the page.
    differences: follow::Phone,
    /// The entry to the document's earlier versions (#1185), read with the page.
    earlier: earlier::Foot,
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
        let about = links::read_people(ctx, &self.document_id);
        self.differences = match &document {
            Reading::Data(_) => follow::read(ctx, &self.document_id),
            _ => follow::Phone::default(),
        };
        self.earlier = match &document {
            Reading::Data(found) if found.document.is_some() => {
                earlier::foot(ctx, super::EARLIER, &self.document_id, "")
            }
            _ => earlier::Foot::default(),
        };
        self.phase = match document {
            Reading::Data(document) => Phase::Ready(Answered {
                document,
                drive: match drive {
                    Reading::Data(drive) => Some(drive),
                    _ => None,
                },
                about: match about {
                    Reading::Data(people) => Some(people),
                    _ => None,
                },
            }),
            Reading::Denied(denial) => Phase::Denied(denial),
            Reading::Failed => Phase::Failed,
        };
    }

    /// The ids of the people the document is about now.
    fn about_ids(&self) -> Vec<String> {
        self.phase
            .data()
            .and_then(|answered| answered.about.as_ref())
            .map(|people| people.iter().map(|p| p.party_id.clone()).collect())
            .unwrap_or_default()
    }

    /// One event of the About section or its picker.
    fn about_event(&mut self, event: &wire::LinkEvent, ctx: &Ctx) {
        let linked = self.about_ids();
        let id = self.document_id.clone();
        match self.links.update(event, &linked, ctx) {
            Outcome::Add { id: person, .. } => {
                self.write(
                    ctx,
                    act::docs::AddAbout {
                        from: id,
                        rel: act::docs::AddAboutRel::About,
                        to: person,
                    },
                    words::about_added,
                );
            }
            Outcome::Remove { id: person } => {
                self.write(
                    ctx,
                    act::docs::RemoveAbout {
                        from: id,
                        rel: act::docs::RemoveAboutRel::About,
                        to: person,
                    },
                    words::about_removed,
                );
            }
            Outcome::Moved => {}
        }
    }

    fn row(&self) -> Option<&wire::DocsDocumentRow> {
        self.phase.data()?.document.document.as_ref()
    }

    /// A write the status line says, with Undo when the core can take it back.
    fn write(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        said: impl FnOnce(Locale) -> String,
    ) -> bool {
        let request: wire::ActRequest = request.into();
        let key = kit_act::key(&[&request.action, &self.document_id], kit_act::fresh());
        let settled = self.undo.act(ctx, request, &key, said);
        self.reload(ctx);
        settled.committed
    }

    /// The action under the "folder says" line: take the folder's name, then read again so the
    /// line goes. A refusal is the status line, over the page as it still is.
    fn take_folder(&mut self, ctx: &Ctx, taken: &wire::PhoneSaysTaken) {
        if self.row().is_none() {
            return;
        }
        let Some(settled) = follow::take(ctx, &self.document_id, taken) else {
            return;
        };
        // Taking the folder's value has no inverse: it says nothing and offers nothing.
        self.undo.clear();
        if !settled.committed {
            self.undo.refuse(settled.refusal);
        }
        self.reload(ctx);
    }

    /// Share the document's file: the owner check first, since the bytes leave
    /// the phone in the clear. A document whose bytes are not on this phone
    /// says so on the status line and asks nothing.
    fn share(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        if self.shared_path().is_empty() {
            self.undo.refuse(words::share_missing(locale));
            return Vec::new();
        }
        self.undo.clear();
        self.gate.begin(locale, Leaving::Share)
    }

    fn shared_path(&self) -> String {
        self.phase
            .data()
            .map(|answered| answered.document.bytes_path.clone())
            .unwrap_or_default()
    }

    /// The owner check's answer: hand the document's file to the platform's
    /// share sheet (the bytes are a file in the store, so nothing is read here).
    fn checked(&mut self, locale: Locale, checked: &wire::OwnerChecked) -> Vec<wire::Effect> {
        match self.gate.answer(locale, NoPasscode::Warn, checked) {
            Some(Owner::Passed) => self.send(locale),
            Some(Owner::PassedUnprotected(warning)) => {
                let effects = self.send(locale);
                if !effects.is_empty() {
                    self.undo.say(warning);
                }
                effects
            }
            Some(Owner::Refused(sentence)) => {
                self.undo.refuse(sentence);
                Vec::new()
            }
            Some(Owner::Cancelled) | None => Vec::new(),
        }
    }

    fn send(&mut self, locale: Locale) -> Vec<wire::Effect> {
        let path = self.shared_path();
        let Some(row) = self.row().cloned().filter(|_| !path.is_empty()) else {
            return Vec::new();
        };
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::ShareFile(wire::ShareFile {
                path,
                name: row.title.clone(),
                media_type: row.media_type.clone(),
                chooser_title: words::share_title(locale),
            })),
        }]
    }

    fn action(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        let Some(row) = self.row().cloned() else {
            return Vec::new();
        };
        // Only what the head offers is done: a key for a verb this document
        // does not have (restore on a live one, trash on a trashed one) is nothing.
        let offered = fold::head_actions(ctx.locale(), &row)
            .into_iter()
            .chain(fold::bar_actions(ctx.locale(), &row))
            .any(|action| action.key == key && action.enabled);
        if !offered {
            return Vec::new();
        }
        let id = row.document_id.clone();
        match key {
            KEY_SHARE => return self.share(ctx),
            KEY_STAR => {
                self.write(
                    ctx,
                    act::docs::Star { document_id: id },
                    words::starred_said,
                );
            }
            KEY_UNSTAR => {
                self.write(
                    ctx,
                    act::docs::Unstar { document_id: id },
                    words::unstarred_said,
                );
            }
            KEY_RESTORE => {
                self.write(ctx, act::docs::Restore { document_id: id }, |locale| {
                    trash::restored(locale, &row.title)
                });
            }
            KEY_RENAME => {
                if self.rename.is_some() {
                    self.close_rename(ctx);
                    if self.rename.is_some() {
                        return Vec::new();
                    }
                }
                self.rename = Some(Rename::open(ctx, &id, &row.title));
            }
            KEY_MOVE => self.sheet = Sheet::Move,
            KEY_LABELS => self.sheet = Sheet::Labels(String::new()),
            KEY_TRASH => self.asking = Asking::Trash,
            KEY_PURGE => self.asking = Asking::Purge,
            // `edit` is a route the shell pushes (the action carries it).
            _ => {}
        }
        Vec::new()
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
            words::moved_said,
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
                color: None,
            },
            words::label_added_said,
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
            words::label_removed_said,
        );
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        let asking = std::mem::replace(&mut self.asking, Asking::None);
        let id = self.document_id.clone();
        match asking {
            Asking::Trash => {
                let title = self.row().map(|row| row.title.clone()).unwrap_or_default();
                self.write(ctx, act::docs::Trash { document_id: id }, |locale| {
                    trash::moved_to_trash(locale, &title)
                });
            }
            Asking::Purge => {
                // DELETED FOREVER: nothing is left to show, so the page leaves.
                let key = kit_act::key(&["purge", &id], kit_act::fresh());
                let purged = self
                    .undo
                    .act_quietly(ctx, act::docs::Purge { document_id: id }, &key)
                    .committed;
                self.reload(ctx);
                if purged {
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

    fn event(&mut self, event: wire::DocsDocumentEvent, ctx: &Ctx) -> Vec<wire::Effect> {
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
                    return self.action(ctx, &picked.key);
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
            Some(D::About(link)) => self.about_event(&link, ctx),
            None => {}
        }
        Vec::new()
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
                title: crate::kit::trash::purge_title(locale, shared::trash_noun_document),
                body: crate::kit::trash::purge_body(locale, None),
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
        let rail_entries = answered
            .drive
            .as_ref()
            .map(|drive| drive.label_entries.as_slice())
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
                Body::Labels(fold::labels_sheet(
                    locale,
                    row,
                    rail_labels,
                    rail_entries,
                    draft,
                )),
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
            Some(E::StatusActed(_)) => {
                // A rename the vault refused as stale: Reload keeps the title typed and reads it again.
                if self.rename.as_ref().is_some_and(Rename::conflicted) {
                    if self
                        .rename
                        .as_mut()
                        .is_some_and(|rename| !rename.reload(ctx))
                    {
                        self.rename = None;
                    }
                    self.reload(ctx);
                } else if self.undo.acted(ctx) {
                    self.reload(ctx);
                }
            }
            Some(E::Left(_)) => {
                self.undo.clear();
                if let Some(rename) = self.rename.as_mut() {
                    let _ = rename.close(ctx);
                }
                return self.gate.cancel();
            }
            Some(E::EffectResult(result)) => {
                match &result.outcome {
                    Some(wire::effect_result::Outcome::OwnerChecked(checked)) => {
                        return self.checked(ctx.locale(), checked);
                    }
                    // The prompt itself errored: the same as not recognised.
                    Some(wire::effect_result::Outcome::Failed(_)) if self.gate.asking() => {
                        let failed = wire::OwnerChecked {
                            outcome: wire::owner_checked::Outcome::Failed as i32,
                            ..Default::default()
                        };
                        return self.checked(ctx.locale(), &failed);
                    }
                    _ => {}
                }
            }
            Some(E::DocsDocument(event)) => return self.event(event, ctx),
            Some(E::PhoneSaysTaken(taken)) => self.take_folder(ctx, &taken),
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
                    ctx.units(),
                    ctx.hour_cycle(),
                    &answered.document,
                    answered.drive.as_ref(),
                );
                // THE ABOUT SECTION (#1173): who the document is about, on a live document.
                if let (Some(people), Some(row)) = (answered.about.as_ref(), data.row.as_ref())
                    && !row.trashed
                {
                    data.about = Some(self.links.section(
                        locale,
                        link_words::section_about(locale),
                        links::person_rows(locale, people),
                        String::new(),
                    ));
                }
                // THE FOLDER'S NAME, under the title, where the member renamed it (#1183). `blob`
                // and `media_type` are the file's own bytes and kind, which the page never offers
                // to edit, so only the title has a line.
                data.title_phone_says = follow::of(&self.differences, "title")
                    .and_then(|title| follow::text(&title.stated))
                    .map(|name| {
                        follow::says(
                            locale,
                            Source::Folder,
                            &name,
                            &words::says_noun_name(locale),
                            "title",
                            None,
                        )
                    });
                // THE FOOT'S "Earlier versions" ROW (#1185): the kit's entry, its route naming the
                // page the member comes from by the title drawn.
                let drawn = data.row.as_ref().map(|row| row.title.clone());
                data.origin = self.earlier.origin.clone();
                data.earlier = self.earlier.entry.as_ref().map(|entry| wire::EarlierEntry {
                    route: Some(earlier::route(
                        super::EARLIER,
                        &self.document_id,
                        drawn.as_deref().unwrap_or_default(),
                    )),
                    ..entry.clone()
                });
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
                    status: self
                        .undo
                        .status()
                        .or_else(|| self.differences.status(locale, Source::Folder))
                        .or_else(|| self.earlier.status(locale)),
                    confirm: self.confirm(locale),
                    rename: self.rename.as_ref().map(|rename| rename.view(locale)),
                    sheet,
                    chrome: Some(self.chrome(locale)),
                    dismissed: self.dismissed,
                    about_picker: Some(self.links.picker(locale, &self.about_ids())),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::owner_checked::Outcome as O;

    fn holding() -> Document {
        Document {
            document_id: "d1".to_owned(),
            title_hint: String::new(),
            parent: String::new(),
            phase: Phase::Ready(Answered {
                document: wire::DocsDocument {
                    document: Some(wire::DocsDocumentRow {
                        title: "Lease.pdf".to_owned(),
                        ..Default::default()
                    }),
                    bytes_path: "/store/lease".to_owned(),
                    ..Default::default()
                },
                drive: None,
                about: None,
            }),
            undo: Undo::default(),
            gate: OwnerGate::default(),
            asking: Asking::None,
            sheet: Sheet::None,
            rename: None,
            dismissed: false,
            links: Links::new(&[Kind::Person]),
            differences: follow::Phone::default(),
            earlier: earlier::Foot::default(),
        }
    }

    fn asked(outcome: O) -> (Vec<wire::Effect>, Document) {
        let mut doc = holding();
        let up = doc.gate.begin(Locale::En, Leaving::Share);
        assert!(matches!(
            up[0].kind,
            Some(wire::effect::Kind::OwnerCheck(ref c)) if c.ask
        ));
        let effects = doc.checked(
            Locale::En,
            &wire::OwnerChecked {
                outcome: outcome as i32,
                ..Default::default()
            },
        );
        (effects, doc)
    }

    fn is_share(effects: &[wire::Effect]) -> bool {
        matches!(
            effects,
            [wire::Effect {
                kind: Some(wire::effect::Kind::ShareFile(_))
            }]
        )
    }

    #[test]
    fn a_passed_check_shares_and_a_phone_with_no_passcode_shares_with_a_warning() {
        let (effects, doc) = asked(O::Succeeded);
        assert!(is_share(&effects) && doc.undo.status().is_none());
        let (effects, doc) = asked(O::Unavailable);
        assert!(is_share(&effects));
        assert!(
            doc.undo
                .status()
                .is_some_and(|s| !s.refused && !s.sentence.is_empty())
        );
    }

    #[test]
    fn a_dismissed_or_failed_check_shares_nothing() {
        let (effects, doc) = asked(O::Cancelled);
        assert!(effects.is_empty() && doc.undo.status().is_none());
        let (effects, doc) = asked(O::Failed);
        assert!(effects.is_empty() && doc.undo.status().is_some_and(|s| s.refused));
    }
}
