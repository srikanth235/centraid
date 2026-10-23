//! THE NOTES EDITOR (`notes.editor`), autosaving (#1015 D3: close = done), with
//! the link powerbox as a sheet it owns.
//!
//! The editor is the screen where the read law and the WRITE law differ, and
//! keeping them apart is most of this file: a failed READ replaces the editor,
//! a failed SAVE does not. A member whose save was refused still has their
//! words on the screen, and an editor that swapped them for an error message
//! would have thrown away the only copy.
//!
//! The save itself is the kit's [`Autosave`]: an edit schedules a save 900 ms
//! later, leaving saves whatever is unsaved, each save is one action under one
//! key, only changed fields are sent, and a change from the vault never
//! replaces words being typed. A pin is not typing: it is its own action, sent
//! at once.
//!
//! **A new note is not read.** Nothing is in the vault under its id yet, and a
//! read would answer "could not find this note". It opens on an empty draft;
//! its first save is a create (whose output names the note), and every later
//! save an edit of it.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::notes_editor_event::Kind as N;
use wire::screen_event::Kind as E;

use super::{Phase, denied, fold, routes};
use crate::agenda;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::autosave::{Autosave, Draft};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, notes as words};

const BRACKETS: &str = "[[";

/// The words a member types: a note not yet created has no id.
#[derive(Clone, Debug, PartialEq, Eq)]
struct NoteDraft {
    /// `None` until the first save creates the note.
    id: Option<String>,
    title: String,
    body: String,
}

impl Draft for NoteDraft {
    const ACTION: &'static str = "note.edit";

    fn subject(&self) -> &str {
        self.id.as_deref().unwrap_or("new")
    }

    /// A NEW NOTE NEEDS A NAME: `note.create` requires a title, and an empty
    /// one is derived from the body's first line — so a note with neither is
    /// not yet a note. A body cleared to nothing IS saved: `body` takes an
    /// empty string.
    fn refusal(&self, locale: Locale) -> Option<String> {
        (self.id.is_none() && self.title.trim().is_empty() && fold::first_line(&self.body).is_empty())
            .then(|| words::write_a_line(locale))
    }

    /// `note.create` with the whole draft, or `note.edit` with ONLY THE FIELDS
    /// THAT CHANGED against `baseline` (an absent field is "leave it alone").
    ///
    /// * An empty title is DERIVED from the body's first line, because a note
    ///   with no title is still a note a member means to keep and the first
    ///   line is what names it. The draft keeps its empty title; the vault gets
    ///   the derived one, and a re-read does not put it back ([`keep_derived`]).
    ///   No first line: a changed title is sent EMPTY, so a name the member
    ///   removed does not stay in the vault and come back on the next read.
    /// * The pin is not an input: it is the shared flag verbs.
    /// * There is no vault-side version check: the last save on this phone wins.
    fn request(&self, baseline: &Self) -> Option<wire::ActRequest> {
        let title = if self.title.trim().is_empty() {
            fold::first_line(&self.body)
        } else {
            self.title.clone()
        };
        let Some(id) = &self.id else {
            return Some(
                act::notes::CreateNote {
                    title,
                    body: self.body.clone(),
                    format: Some(act::notes::CreateNoteFormat::Markdown),
                    ..Default::default()
                }
                .into(),
            );
        };
        let body_changed = self.body != baseline.body;
        let title_changed =
            self.title != baseline.title || (self.title.trim().is_empty() && body_changed);
        if !title_changed && !body_changed {
            return None;
        }
        Some(
            act::notes::EditNote {
                note_id: id.clone(),
                title: title_changed.then_some(title),
                body: body_changed.then(|| self.body.clone()),
                format: None,
            }
            .into(),
        )
    }

    fn committed(&mut self, output: &[u8]) {
        if self.id.is_some() {
            return;
        }
        self.id = serde_json::from_slice::<serde_json::Value>(output)
            .ok()
            .and_then(|value| value.get("id")?.as_str().map(str::to_owned));
    }
}

/// A DERIVED TITLE STAYS DERIVED. The vault stores the title a save derived
/// from the body's first line, and the clean re-read after that save brings it
/// back — which would fill the field, so a later first-line edit no longer
/// renamed the note. While the draft's title is empty and the stored one is the
/// body's first line, the field stays empty; a name from anywhere else is
/// adopted. A fresh open (no draft yet) draws the stored title.
fn keep_derived(current: Option<&NoteDraft>, mut incoming: NoteDraft) -> NoteDraft {
    let derived = current.is_some_and(|current| current.title.trim().is_empty())
        && !incoming.title.is_empty()
        && incoming.title == fold::first_line(&incoming.body);
    if derived {
        incoming.title.clear();
    }
    incoming
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::NotesEditor(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Editor {
        note_id: Some(args.note_id.clone()).filter(|id| !id.is_empty()),
        auto: Autosave::new(),
        blocked: None,
        denied: None,
        pinned: false,
        status: None,
        link: None,
        started: false,
    }))
}

/// The powerbox: what a note can link to, where in the body it lands and
/// whether it replaces a typed `[[`.
struct LinkSheet {
    /// A character offset into the body.
    anchor: usize,
    replaces: bool,
    term: String,
    phase: Phase<Vec<wire::NotesLinkTarget>>,
}

struct Editor {
    /// The note's id, once there is one.
    note_id: Option<String>,
    auto: Autosave<NoteDraft>,
    /// The read that replaced the editor: the note is gone, trashed or unreadable.
    blocked: Option<wire::Failure>,
    denied: Option<wire::AppQueryDenial>,
    pinned: bool,
    /// A pin's refusal.
    status: Option<String>,
    link: Option<LinkSheet>,
    /// `Appeared` has been seen.
    started: bool,
}

impl Editor {
    fn reload(&mut self, ctx: &Ctx) {
        let Some(id) = self.note_id.clone() else {
            return;
        };
        let locale = ctx.locale();
        let reading = read::read(ctx, load::notes::Note { note_id: id.clone() }, |answer| {
            match answer {
                Answer::NotesNote(note) => Some(note),
                _ => None,
            }
        });
        match reading {
            Reading::Data(note) if !note.found => self.refuse(words::note_missing(locale)),
            Reading::Data(note) if note.deleted_at.is_some() => {
                self.refuse(words::note_trashed(locale));
            }
            Reading::Data(note) => {
                self.blocked = None;
                self.denied = None;
                self.pinned = note.pinned;
                let incoming = keep_derived(
                    self.auto.draft(),
                    NoteDraft {
                        id: Some(id),
                        title: note.title,
                        body: note.body,
                    },
                );
                if self.auto.loaded(incoming) {
                    // Nothing was typed over: the draft is the vault's.
                }
            }
            Reading::Denied(denial) => {
                self.auto = Autosave::new();
                self.denied = Some(denial);
            }
            Reading::Failed => {
                self.auto = Autosave::new();
                self.blocked = Some(read::failure(locale));
            }
        }
    }

    /// A FAILED READ REPLACES THE EDITOR: there is nothing to edit.
    fn refuse(&mut self, sentence: String) {
        self.auto = Autosave::new();
        self.blocked = Some(wire::Failure {
            sentence,
            remedy: String::new(),
        });
    }

    /// The note was created by a save: it has an id now, and a pin chosen
    /// before it existed lands.
    fn after_save(&mut self, ctx: &Ctx) {
        if self.note_id.is_some() {
            return;
        }
        let Some(id) = self.auto.draft().and_then(|draft| draft.id.clone()) else {
            return;
        };
        self.note_id = Some(id.clone());
        if self.pinned {
            self.write_pin(ctx, &id, true);
        }
        // READ IT ONCE: the screen then knows which tables it depends on, so the
        // vault's own changes reach it from here on.
        self.reload(ctx);
    }

    fn write_pin(&mut self, ctx: &Ctx, id: &str, pinned: bool) {
        let request: wire::ActRequest = if pinned {
            act::notes::FlagNote {
                note_id: id.to_owned(),
                flag: act::notes::FlagNoteFlag::Pinned,
            }
            .into()
        } else {
            act::notes::UnflagNote {
                note_id: id.to_owned(),
                flag: act::notes::UnflagNoteFlag::Pinned,
            }
            .into()
        };
        let key = kit_act::key(&[&request.action.clone(), id], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.status = (!settled.committed).then_some(settled.refusal);
    }

    fn pin(&mut self, ctx: &Ctx) {
        if self.auto.draft().is_none() {
            return;
        }
        self.pinned = !self.pinned;
        self.status = None;
        // A note not yet in the vault takes the pin after its create lands.
        if let Some(id) = self.note_id.clone() {
            let pinned = self.pinned;
            self.write_pin(ctx, &id, pinned);
            if self.status.is_some() {
                self.pinned = !pinned;
            }
        }
    }

    fn save_now(&mut self, ctx: &Ctx) {
        if self.auto.flush(ctx) {
            self.reload(ctx);
        }
        self.after_save(ctx);
    }

    fn body_edited(&mut self, ctx: &Ctx, after: String) {
        let Some(before) = self.auto.draft().map(|draft| draft.body.clone()) else {
            return;
        };
        self.auto.edit(ctx, |draft| draft.body.clone_from(&after));
        if let Some((anchor, replaces)) = bracket_opened(&before, &after) {
            self.open_link(ctx, anchor, replaces);
        }
    }

    fn open_link(&mut self, ctx: &Ctx, anchor: usize, replaces: bool) {
        self.link = Some(LinkSheet {
            anchor,
            replaces,
            term: String::new(),
            phase: Phase::Loading,
        });
        self.read_links(ctx);
    }

    fn read_links(&mut self, ctx: &Ctx) {
        let Some(sheet) = &mut self.link else {
            return;
        };
        sheet.phase = Phase::of(read::read(
            ctx,
            load::notes::LinkTargets {
                term: sheet.term.trim().to_owned(),
            },
            |answer| match answer {
                Answer::NotesLinkTargets(found) => Some(found.targets),
                _ => None,
            },
        ));
    }

    fn pick_link(&mut self, ctx: &Ctx, id: &str) {
        let Some(sheet) = self.link.take() else {
            return;
        };
        let locale = ctx.locale();
        let Some(target) = sheet
            .phase
            .data()
            .and_then(|targets| targets.iter().find(|target| target.id == id))
        else {
            return;
        };
        let title = if target.title.trim().is_empty() {
            words::untitled(locale)
        } else {
            target.title.clone()
        };
        let Some(body) = self.auto.draft().map(|draft| draft.body.clone()) else {
            return;
        };
        let spliced = splice_link(&body, sheet.anchor, sheet.replaces, &title);
        self.auto.edit(ctx, |draft| draft.body = spliced);
    }

    fn event(&mut self, event: wire::NotesEditorEvent, ctx: &Ctx) {
        match event.kind {
            Some(N::Title(edited)) => self.auto.edit(ctx, |draft| draft.title = edited.title),
            Some(N::Body(edited)) => self.body_edited(ctx, edited.body),
            Some(N::Pin(_)) => self.pin(ctx),
            // THE POWERBOX. The link button opens it at the END of the note,
            // whatever a field's caret says (no shell reports one); a pick
            // lands `[[title]]` there and saves like any edit.
            Some(N::LinkRequested(_)) => {
                if let Some(draft) = self.auto.draft() {
                    let anchor = draft.body.chars().count();
                    self.open_link(ctx, anchor, false);
                }
            }
            Some(N::LinkTerm(typed)) => {
                if let Some(sheet) = &mut self.link {
                    if sheet.term == typed.term {
                        return;
                    }
                    sheet.term = typed.term;
                    self.read_links(ctx);
                }
            }
            Some(N::LinkPicked(picked)) => self.pick_link(ctx, &picked.id),
            Some(N::LinkDismissed(_)) => self.link = None,
            Some(N::Refreshed(_)) => {
                if self.note_id.is_some() {
                    self.reload(ctx);
                }
            }
            Some(N::Save(_)) => self.save_now(ctx),
            None => {}
        }
    }

    fn sheet_view(&self, locale: Locale, sheet: &LinkSheet) -> wire::NotesLinkSheet {
        let content = match &sheet.phase {
            Phase::Loading => {
                wire::notes_link_sheet::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::notes_link_sheet::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => {
                wire::notes_link_sheet::Content::Denied(denied(locale, denial))
            }
            Phase::Ready(targets) => {
                let domains = fold::link_domains(locale, targets);
                let empty = domains.is_empty().then(|| wire::EmptyState {
                    headline: words::link_empty_headline(locale),
                    body: if sheet.term.trim().is_empty() {
                        words::link_empty_body(locale)
                    } else {
                        words::link_no_match_body(locale)
                    },
                    ..wire::EmptyState::default()
                });
                wire::notes_link_sheet::Content::Data(wire::NotesLinkData {
                    domains,
                    empty,
                })
            }
        };
        wire::NotesLinkSheet {
            term: sheet.term.clone(),
            title: words::link_title(locale),
            search_placeholder: words::link_search(locale),
            close: words::close(locale),
            retry: words::retry(locale),
            loading_label: words::loading_links(locale),
            foot: words::powerbox_foot(locale),
            content: Some(content),
        }
    }
}

/// `[[` JUST TYPED opens the powerbox there: the anchor (a character offset)
/// and that it replaces the typed pair. Measured against the body before the
/// edit, so a `[[` already in the note never reopens it.
fn bracket_opened(before: &str, after: &str) -> Option<(usize, bool)> {
    let before: Vec<char> = before.chars().collect();
    let after: Vec<char> = after.chars().collect();
    if after.len() <= before.len() || pairs(&after) <= pairs(&before) {
        return None;
    }
    let common = before
        .iter()
        .zip(&after)
        .take_while(|(a, b)| a == b)
        .count();
    let from = common.saturating_sub(1);
    (from..after.len().saturating_sub(1))
        .find(|&at| after[at] == '[' && after[at + 1] == '[')
        .map(|anchor| (anchor, true))
}

/// How many overlapping `[[` pairs `text` holds.
fn pairs(text: &[char]) -> usize {
    text.windows(2)
        .filter(|pair| pair[0] == '[' && pair[1] == '[')
        .count()
}

/// `[[title]]` at `anchor`, replacing a typed `[[` there when `replaces`.
///
/// A LINK THE BUTTON PLACED IS ITS OWN WORD: "Middlemarch.[[Book]]" glued the
/// link to the text before it. So a link that did not replace a typed `[[` is
/// set apart — a space after text on the same line, a new line after a heading
/// (a link is not part of the heading), nothing at the start of a line — and
/// from text after it by a space. A typed `[[` is where the member put it, and
/// is left exactly there.
fn splice_link(body: &str, anchor: usize, replaces: bool, title: &str) -> String {
    let chars: Vec<char> = body.chars().collect();
    let at = anchor.min(chars.len());
    let link = format!("{BRACKETS}{title}]]");
    let head: String = chars[..at].iter().collect();
    let rest: String = chars[at..].iter().collect();
    if replaces && rest.starts_with(BRACKETS) {
        return format!("{head}{link}{}", &rest[BRACKETS.len()..]);
    }
    let before = match head.chars().last() {
        None => "",
        Some(last) if last.is_whitespace() => "",
        Some(_) if is_heading(head.rsplit('\n').next().unwrap_or_default()) => "\n",
        Some(_) => " ",
    };
    let after = match rest.chars().next() {
        None => "",
        Some(first) if first.is_whitespace() => "",
        Some(_) => " ",
    };
    format!("{head}{before}{link}{after}{rest}")
}

/// A markdown heading line: one to six `#` and a space.
fn is_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&hashes) && line.chars().nth(hashes).is_some_and(char::is_whitespace)
}

impl Screen for Editor {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                if !self.started {
                    self.started = true;
                    if self.note_id.is_none() {
                        // A NEW NOTE IS NOT READ: it opens on an empty draft.
                        self.auto.loaded(NoteDraft {
                            id: None,
                            title: String::new(),
                            body: String::new(),
                        });
                    } else {
                        self.reload(ctx);
                    }
                }
            }
            // A CHANGE NEVER TAKES A MEMBER'S TYPING: `loaded` keeps unsaved
            // words and notes that the vault moved. The core sends a change for
            // every local commit, this editor's own saves included.
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                if self.note_id.is_some() {
                    self.reload(ctx);
                }
            }
            Some(E::TimerFired(fired)) => {
                if self.auto.fired(ctx, &fired.timer) {
                    self.reload(ctx);
                }
                self.after_save(ctx);
            }
            // CLOSE = DONE: leaving saves what is unsaved.
            Some(E::Left(_)) => self.save_now(ctx),
            Some(E::NotesEditor(event)) => self.event(event, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let autosave = self.auto.view(locale);
        let draft = self.auto.draft();
        let exists = draft.is_some_and(|draft| draft.id.is_some());
        let title = draft.map_or(String::new(), |draft| {
            if draft.title.trim().is_empty() {
                fold::first_line(&draft.body)
            } else {
                draft.title.clone()
            }
        });
        let content = match (draft, &self.blocked, &self.denied) {
            (_, Some(failure), _) => wire::notes_editor_state::Content::Failure(failure.clone()),
            (_, None, Some(denial)) => wire::notes_editor_state::Content::Failure(wire::Failure {
                sentence: denied(locale, denial).body,
                remedy: String::new(),
            }),
            (Some(draft), None, None) => wire::notes_editor_state::Content::Draft(wire::NotesEditorDraft {
                title: draft.title.clone(),
                body: draft.body.clone(),
                pinned: self.pinned,
            }),
            (None, None, None) => {
                wire::notes_editor_state::Content::Loading(wire::Loading { first_load: true })
            }
        };
        let phase = wire::autosave::Phase::try_from(autosave.phase)
            .unwrap_or(wire::autosave::Phase::Clean);
        let save_status = match phase {
            wire::autosave::Phase::Saving => words::saving(locale),
            // A save and the clean re-read after it are both "Saved".
            wire::autosave::Phase::Saved => words::saved(locale),
            wire::autosave::Phase::Clean if autosave.edit_seq > 0 => words::saved(locale),
            wire::autosave::Phase::Refused => autosave
                .failure
                .as_ref()
                .map(|failure| failure.sentence.clone())
                .unwrap_or_default(),
            _ => String::new(),
        };
        let agenda_words = title.clone();
        let mut state = wire::NotesEditorState {
            note_id: self.note_id.clone().unwrap_or_default(),
            is_new: !exists,
            content: Some(content),
            chrome: Some(wire::NotesEditorChrome {
                // "Cancel" only before the first keystroke of this visit; after
                // it, close = done, and an autosave does not undo that.
                close: if autosave.edit_seq == 0 {
                    words::cancel(locale)
                } else {
                    words::done(locale)
                },
                title_placeholder: words::title_placeholder(locale),
                body_placeholder: words::body_placeholder(locale),
                pin_label: if self.pinned {
                    words::unpin(locale)
                } else {
                    words::pin(locale)
                },
                history_label: words::history_title(locale),
                send_to_agenda_label: words::send_to_agenda(locale),
                link_label: words::link_label(locale),
                status: self.status.clone().unwrap_or(save_status),
                title: if exists {
                    words::note_title(locale)
                } else {
                    words::new_note(locale)
                },
                menu_label: words::row_menu(locale),
                history_enabled: exists && draft.is_some(),
                retry: words::retry(locale),
            }),
            autosave: Some(autosave),
            link: self.link.as_ref().map(|sheet| self.sheet_view(locale, sheet)),
            history: None,
            send_to_agenda: None,
        };
        if let Some(id) = draft.and_then(|draft| draft.id.as_deref()) {
            state.history = Some(routes::history(id, &title));
        }
        // SEND TO AGENDA: To-do's quick add, the words waiting in it (the Inbox
        // is where they land). Nothing is written until the member adds them.
        if !agenda_words.trim().is_empty() {
            state.send_to_agenda = Some(agenda::routes::home(
                wire::AgendaDestination::Todo,
                agenda_words.trim(),
            ));
        }
        wire::ViewState {
            kind: Some(wire::view_state::Kind::NotesEditor(state)),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_is_its_own_word() {
        assert_eq!(splice_link("Middlemarch.", 12, false, "Book"), "Middlemarch. [[Book]]");
        assert_eq!(splice_link("", 0, false, "Book"), "[[Book]]");
        assert_eq!(splice_link("# Heading", 9, false, "Book"), "# Heading\n[[Book]]");
        assert_eq!(splice_link("one\n", 4, false, "Book"), "one\n[[Book]]");
        assert_eq!(splice_link("see [[ now", 4, true, "Book"), "see [[Book]] now");
        assert_eq!(splice_link("ab", 1, false, "X"), "a [[X]] b");
    }

    #[test]
    fn typing_two_brackets_opens_the_powerbox_once() {
        assert_eq!(bracket_opened("see ", "see [["), Some((4, true)));
        assert_eq!(bracket_opened("see [", "see [["), Some((4, true)));
        assert_eq!(bracket_opened("see [[x]]", "see [[x]]!"), None);
        assert_eq!(bracket_opened("", "plain"), None);
    }

    #[test]
    fn a_derived_title_stays_derived() {
        let current = NoteDraft {
            id: Some("n".into()),
            title: String::new(),
            body: "Milk".into(),
        };
        let incoming = NoteDraft {
            id: Some("n".into()),
            title: "Milk".into(),
            body: "Milk".into(),
        };
        assert_eq!(keep_derived(Some(&current), incoming.clone()).title, "");
        assert_eq!(keep_derived(None, incoming).title, "Milk");
    }
}
