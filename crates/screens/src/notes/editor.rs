//! THE NOTES EDITOR (`notes.editor`), autosaving (#1015 D3: close = done), with
//! the link powerbox as a sheet it owns.
//!
//! The editor is the screen where the read law and the WRITE law differ, and
//! keeping them apart is most of this file: a failed first READ replaces the editor,
//! while a failed reread or SAVE preserves the member's words. A member whose save was refused still has their
//! words on the screen, and an editor that swapped them for an error message
//! would have thrown away the only copy.
//!
//! The save itself is the kit's [`Autosave`]: an edit schedules a save 900 ms
//! later, leaving saves whatever is unsaved, each save is one action under one
//! key, only changed fields are sent, and a change from the vault never
//! replaces words being typed. A pin is not typing: it is its own action, sent
//! at once.
//!
//! **THE BODY, DRAWN.** With a draft, the view carries `rich`: the pure parse
//! of the draft body ([`rich::parse`]) as blocks (heading, checklist, bullet,
//! quote, paragraph) and spans (emphasis, strong, strike, code, faint syntax,
//! links). Every range is in UTF-16 units of the draft body, the unit both
//! shells index text in; `body_length` is the whole body's length in them. The
//! parse is linear and bounded ([`rich::MAX_UTF16`], `MAX_BLOCKS`,
//! `MAX_SPANS`; `truncated` says a bound was hit and the rest is plain), so the
//! view parses on every call instead of caching: a cache behind `&self` would
//! need interior mutability, and the parse costs a bounded pass.
//!
//! **Wiki links resolve in `update`, never in `view`.** `[[Title]]` is looked up
//! once per typed title in a cache (resolved to a live note, trashed, or
//! missing) filled by [`Editor::resolve`]: at most 32 `link-targets` reads (the
//! parse caps distinct titles) plus ONE `trash` read per call, and none while
//! typing adds no new title. A read that fails caches nothing (the chip shows
//! MISSING and is retried on the next update). After each fill the cache is
//! PRUNED to the titles the body holds now. The view only consults it.
//!
//! **What clears the cache.** A note may have been renamed, trashed or restored
//! by something other than this editor, so `EnvironmentChanged`, `Refreshed`
//! and every `DataChanged` this editor did not cause CLEAR it. The core sends a
//! `DataChanged` after every local commit, this editor's own saves included, and
//! re-reading up to 33 times per save would be waste: an own commit is told by
//! its MARKS (see [`Editor::own`]) and keeps the cache, except for the entries
//! the saved note itself can change (its id, its old and its new title).
//!
//! **Core edits.** A checklist tap, Return and the status line's Undo are
//! edits the core makes to the body (`rich::toggle`, `rich::return_at`) and
//! saves like any other; Return also asks the shell to place the caret
//! (`selection`, applied once per `seq`). A toggle says "Item checked" with
//! an Undo that holds only until any other edit.
//!
//! **A new note is not read.** Nothing is in the vault under its id yet, and a
//! read would answer "could not find this note". It opens on an empty draft;
//! its first save is a create (whose output names the note), and every later
//! save an edit of it.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::notes_editor_event::Kind as N;
use wire::screen_event::Kind as E;

use super::rich::{self, LinkTarget};
use super::{Phase, denied, fold, routes};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::autosave::{Autosave, Draft};
use crate::kit::civil;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, notes as words};
use std::collections::{BTreeSet, HashMap};

const BRACKETS: &str = "[[";

/// What a typed `[[title]]` is, as last read.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Resolution {
    Resolved { id: String, title: String },
    /// In the trash, as this note: the id Restore brings back.
    Trashed { id: String },
    Missing,
}

/// WHAT A TAP ON A DEAD LINK OFFERS, on the status line beside its sentence: make the note the
/// link names, or bring the trashed one back. Either opens the note afterwards.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Offer {
    Create { title: String },
    Restore { id: String, title: String },
}

/// The toggle the status line's Undo takes back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Undo {
    /// The checklist marker's UTF-16 start.
    at: u32,
    /// The item's state after the toggle.
    checked_after: bool,
}

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
        (self.id.is_none()
            && self.title.trim().is_empty()
            && fold::first_line(&self.body).is_empty())
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

/// The title a save gives the note: the field, else the body's first line.
fn effective_title(draft: &NoteDraft) -> String {
    if draft.title.trim().is_empty() {
        fold::first_line(&draft.body)
    } else {
        draft.title.clone()
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
        read_failure: None,
        denied: None,
        pinned: false,
        tags: Vec::new(),
        meta: String::new(),
        status: None,
        said: false,
        undo: None,
        offer: None,
        selection: None,
        selection_seq: 0,
        resolutions: HashMap::new(),
        own: BTreeSet::new(),
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
    /// A failed reread is said over the existing draft, never in its place.
    read_failure: Option<String>,
    denied: Option<wire::AppQueryDenial>,
    pinned: bool,
    /// The tags the vault holds for the note: `(concept id, label)`.
    tags: Vec<(String, String)>,
    /// The line over the title: "Travel · Edited Wed 4 November".
    meta: String,
    /// A pin's refusal.
    status: Option<String>,
    /// `status` holds an editing sentence (item checked, no such note), which
    /// any body edit takes away; a pin's refusal is not one.
    said: bool,
    /// The toggle Undo would take back; shown while its sentence is.
    undo: Option<Undo>,
    /// The Create or Restore a dead link's sentence carries; shown while its sentence is.
    offer: Option<Offer>,
    /// Where the caret goes after a core edit, until the shell's next edit.
    selection: Option<u32>,
    selection_seq: u64,
    /// Typed `[[title]]` to what it resolved to. Never holds a failed read.
    resolutions: HashMap<String, Resolution>,
    /// THE MARKS OF THIS EDITOR'S OWN COMMITS: the tables its committed writes
    /// (a save, a pin, a tag) wrote, from the act's `tables`.
    ///
    /// The core queues one `DataChanged` per table per commit, and a screen's
    /// `act` runs under the runtime's lock, so the change for a commit is heard
    /// only after the `act` returned and its marks were set. A `DataChanged`
    /// whose every table has a mark consumes those marks and is our own: the
    /// note is read again, the resolutions are kept. A table without a mark, an
    /// event naming no table, `EnvironmentChanged` and `Refreshed` are foreign
    /// (a rename or a trash from elsewhere) and clear the cache.
    ///
    /// OBLIGATION: a mark stands for ONE pending change per table, because the
    /// queue coalesces same-table changes: marking twice is one mark. A foreign
    /// commit coalesced into our own change on the same table is therefore
    /// taken for ours, and a mark for a table this screen never read is never
    /// consumed; either leaves the cache stale until the next foreign change,
    /// `Refreshed` or reopen. Never widen what a mark covers (no marks for
    /// tables the act did not write, none carried across `EnvironmentChanged`).
    own: BTreeSet<String>,
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
        let reading = read::read(
            ctx,
            load::notes::Note {
                note_id: id.clone(),
            },
            |answer| match answer {
                Answer::NotesNote(note) => Some(note),
                _ => None,
            },
        );
        match reading {
            Reading::Data(note) if !note.found => self.refuse(words::note_missing(locale)),
            Reading::Data(note) if note.deleted_at.is_some() => {
                self.refuse(words::note_trashed(locale));
            }
            Reading::Data(note) => {
                self.read_failure = None;
                self.blocked = None;
                self.denied = None;
                self.pinned = note.pinned;
                self.tags = note
                    .tags
                    .iter()
                    .map(|tag| (tag.concept_id.clone(), tag.label.clone()))
                    .collect();
                self.meta = Self::meta_of(ctx, &note);
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
                self.resolve(ctx);
            }
            Reading::Denied(denial) => {
                self.auto = Autosave::new();
                self.denied = Some(denial);
            }
            Reading::Failed if self.auto.draft().is_some() => {
                self.read_failure = Some(read::failure(locale).sentence);
            }
            Reading::Failed => {
                self.auto = Autosave::new();
                self.blocked = Some(read::failure(locale));
            }
        }
    }

    /// THE LINE OVER THE TITLE: the notebook the note is filed in, then when it
    /// was last edited, on the member's day. A note filed nowhere says only the
    /// day; a read that gave neither says nothing.
    fn meta_of(ctx: &Ctx, note: &wire::NotesNote) -> String {
        let locale = ctx.locale();
        let day = if note.updated_local_day.is_empty() {
            note.updated_at.as_str()
        } else {
            note.updated_local_day.as_str()
        };
        let edited = day.get(..10).map(|day| {
            format!(
                "{} {}",
                words::edited(locale),
                civil::day_month(locale, day)
            )
        });
        let notebook = note.notebook_id.as_deref().and_then(|id| {
            let notebooks = read::read(
                ctx,
                load::notes::Notebooks::default(),
                |answer| match answer {
                    Answer::NotesNotebooks(notebooks) => Some(notebooks),
                    _ => None,
                },
            );
            let Reading::Data(notebooks) = notebooks else {
                return None;
            };
            notebooks
                .notebooks
                .iter()
                .find(|notebook| notebook.notebook_id == id)
                .map(|notebook| fold::notebook_name(locale, notebook))
        });
        notebook
            .into_iter()
            .chain(edited)
            .collect::<Vec<_>>()
            .join(" · ")
    }

    /// THE TOOLBAR'S CHECKLIST KEY: a new unchecked line at the end of the note,
    /// on a line of its own. It is an edit like any other, so it saves the same
    /// way; the shell takes the body back from the state.
    fn checklist(&mut self, ctx: &Ctx) {
        let Some(body) = self.auto.draft().map(|draft| draft.body.clone()) else {
            return;
        };
        let lead = if body.is_empty() || body.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let next = format!("{body}{lead}- [ ] ");
        self.forget_sentence();
        self.auto.edit(ctx, |draft| draft.body = next);
        self.resolve(ctx);
    }

    /// An edit takes the editing sentence and its Undo away.
    fn forget_sentence(&mut self) {
        self.undo = None;
        self.offer = None;
        if self.said {
            self.status = None;
            self.said = false;
        }
    }

    /// Say an editing sentence on the status line.
    fn say(&mut self, sentence: String) {
        self.status = Some(sentence);
        self.said = true;
    }

    /// The draft body's parse: the view's and every event's one source.
    fn parsed(&self) -> Option<rich::Rich> {
        self.auto.draft().map(|draft| rich::parse(&draft.body))
    }

    /// FILL THE RESOLUTION CACHE for the typed titles it lacks (after dropping
    /// those the body no longer holds): one
    /// `link-targets` read each (at most 32, the parse's cap), then ONE `trash`
    /// read for those no live note answered. A failed read caches nothing and
    /// stops the round: the chip shows MISSING and the next update retries.
    fn resolve(&mut self, ctx: &Ctx) {
        let Some(rich) = self.parsed() else {
            return;
        };
        // PRUNE to the titles the body holds now: a title typed and removed
        // costs one read again if it comes back.
        self.resolutions
            .retain(|title, _| rich.wiki_titles.contains(title));
        let titles: Vec<String> = rich
            .wiki_titles
            .into_iter()
            .filter(|title| !self.resolutions.contains_key(title))
            .collect();
        let mut unresolved = Vec::new();
        for title in titles {
            let reading = read::read(
                ctx,
                load::notes::LinkTargets {
                    term: title.clone(),
                },
                |answer| match answer {
                    Answer::NotesLinkTargets(found) => Some(found.targets),
                    _ => None,
                },
            );
            let Reading::Data(targets) = reading else {
                return;
            };
            let wanted = title.trim().to_lowercase();
            match targets.into_iter().find(|target| {
                target.entity == "note" && target.title.trim().to_lowercase() == wanted
            }) {
                Some(target) => {
                    self.resolutions.insert(
                        title,
                        Resolution::Resolved {
                            id: target.id,
                            title: target.title,
                        },
                    );
                }
                None => unresolved.push(title),
            }
        }
        if unresolved.is_empty() {
            return;
        }
        let reading = read::read(ctx, load::notes::Trash::default(), |answer| match answer {
            Answer::NotesTrash(trash) => Some(trash),
            _ => None,
        });
        let Reading::Data(trash) = reading else {
            return;
        };
        for title in unresolved {
            let wanted = title.trim().to_lowercase();
            let trashed = trash.notes.iter().find(|row| {
                row.title
                    .as_deref()
                    .is_some_and(|name| name.trim().to_lowercase() == wanted)
            });
            self.resolutions.insert(
                title,
                match trashed {
                    Some(row) => Resolution::Trashed {
                        id: row.note_id.clone(),
                    },
                    None => Resolution::Missing,
                },
            );
        }
    }

    /// RUN ONE AUTOSAVE STEP (the timer, a flush) AND ACCOUNT FOR WHAT IT
    /// COMMITTED: its tables become marks, and the resolutions the saved note
    /// can change are dropped and read again now (an entry that resolved to it,
    /// one typed as its old or its new title). Returns what the step returned.
    fn saved(
        &mut self,
        ctx: &Ctx,
        step: impl FnOnce(&mut Autosave<NoteDraft>, &Ctx) -> bool,
    ) -> bool {
        let before = self.auto.baseline().map(effective_title);
        let again = step(&mut self.auto, ctx);
        let written = self.auto.take_written();
        if written.is_empty() {
            return again;
        }
        self.own.extend(written);
        let after = self.auto.baseline().map(effective_title);
        let id = self
            .auto
            .draft()
            .and_then(|draft| draft.id.clone())
            .or_else(|| self.note_id.clone());
        let names: Vec<String> = [before, after]
            .into_iter()
            .flatten()
            .map(|title| title.trim().to_lowercase())
            .filter(|title| !title.is_empty())
            .collect();
        self.resolutions.retain(|key, found| {
            let itself = match found {
                Resolution::Resolved { id: target, .. } => id.as_ref() == Some(&*target),
                _ => false,
            };
            !itself && !names.contains(&key.trim().to_lowercase())
        });
        self.resolve(ctx);
        again
    }

    /// A write of this editor that is not a save (pin, tag) committed.
    fn wrote(&mut self, settled: &kit_act::Settled) {
        if settled.committed {
            self.own.extend(settled.tables.iter().cloned());
        }
    }

    /// A checklist circle tapped: flip the item, say so, and offer Undo.
    fn toggle(&mut self, ctx: &Ctx, at: u32) {
        let Some(body) = self.auto.draft().map(|draft| draft.body.clone()) else {
            return;
        };
        let Some(toggled) = rich::toggle(&body, at) else {
            return;
        };
        self.forget_sentence();
        self.auto.edit(ctx, |draft| draft.body = toggled.body);
        self.undo = Some(Undo {
            at: toggled.marker.start,
            checked_after: toggled.checked,
        });
        let locale = ctx.locale();
        self.say(if toggled.checked {
            words::item_checked(locale)
        } else {
            words::item_unchecked(locale)
        });
    }

    /// Undo takes the toggle back only while the item is still as it left it.
    fn undo(&mut self, ctx: &Ctx) {
        let Some(undo) = self.undo.take() else {
            return;
        };
        let Some(body) = self.auto.draft().map(|draft| draft.body.clone()) else {
            return;
        };
        let intact = rich::parse(&body).blocks.iter().any(|block| {
            block.kind == rich::BlockKind::Checklist
                && block.checked == undo.checked_after
                && block.marker.is_some_and(|marker| marker.start == undo.at)
        });
        self.forget_sentence();
        if !intact {
            return;
        }
        if let Some(toggled) = rich::toggle(&body, undo.at) {
            self.auto.edit(ctx, |draft| draft.body = toggled.body);
        }
    }

    /// A chip tapped: a web link opens outside; a note that is not there says
    /// so (a live note's route is the shell's to open).
    fn open_chip(&mut self, ctx: &Ctx, at: u32) -> Vec<wire::Effect> {
        let Some(rich) = self.parsed() else {
            return Vec::new();
        };
        let link = rich
            .spans
            .iter()
            .filter(|span| span.link.is_some())
            .find(|span| span.range.start == at)
            .or_else(|| {
                rich.spans
                    .iter()
                    .filter(|span| span.link.is_some())
                    .find(|span| span.range.start <= at && at < span.range.end)
            })
            .and_then(|span| span.link.as_ref());
        let Some(link) = link else {
            return Vec::new();
        };
        let locale = ctx.locale();
        match &link.target {
            LinkTarget::Url(url) => vec![wire::Effect {
                kind: Some(wire::effect::Kind::OpenUrl(wire::OpenUrl {
                    url: url.clone(),
                })),
            }],
            LinkTarget::Wiki(title) => {
                let (template, offer) = match self.resolutions.get(title) {
                    Some(Resolution::Resolved { .. }) => return Vec::new(),
                    Some(Resolution::Trashed { id }) => (
                        words::link_trashed(locale),
                        Offer::Restore {
                            id: id.clone(),
                            title: title.clone(),
                        },
                    ),
                    _ => (
                        words::link_missing(locale),
                        Offer::Create {
                            title: title.clone(),
                        },
                    ),
                };
                self.forget_sentence();
                self.say(fill(&template, &[("title", title)]));
                self.offer = Some(offer);
                Vec::new()
            }
        }
    }

    /// THE STATUS LINE'S VERB, when it is a dead link's: Create makes the note the link names,
    /// Restore brings the trashed one back, and either opens it. A refusal is the sentence.
    fn accept(&mut self, ctx: &Ctx, offer: Offer) -> Vec<wire::Effect> {
        let (request, title, known): (wire::ActRequest, String, Option<String>) = match offer {
            Offer::Create { title } => (
                act::notes::CreateNote {
                    title: title.clone(),
                    body: String::new(),
                    format: Some(act::notes::CreateNoteFormat::Markdown),
                    ..Default::default()
                }
                .into(),
                title,
                None,
            ),
            Offer::Restore { id, title } => (
                act::notes::RestoreNote {
                    note_id: id.clone(),
                }
                .into(),
                title,
                Some(id),
            ),
        };
        let key = kit_act::key(&[&request.action.clone(), &title], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.wrote(&settled);
        self.forget_sentence();
        if !settled.committed {
            self.say(settled.refusal);
            return Vec::new();
        }
        // The act is this editor's own commit, which keeps the cache: this title means the note
        // now, so it is read again.
        self.resolutions.remove(&title);
        self.resolve(ctx);
        let Some(id) = known.or_else(|| settled.output_text("id")) else {
            return Vec::new();
        };
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                route: Some(routes::editor(&id)),
            })),
        }]
    }

    /// Return, made by the core: the body and where the caret goes.
    fn return_pressed(&mut self, ctx: &Ctx, caret: u32) {
        let Some(body) = self.auto.draft().map(|draft| draft.body.clone()) else {
            return;
        };
        let returned = rich::return_at(&body, caret);
        self.forget_sentence();
        self.auto.edit(ctx, |draft| draft.body = returned.body);
        self.selection_seq += 1;
        self.selection = Some(returned.caret);
        self.resolve(ctx);
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
        if self.auto.saved() {
            self.read_failure = None;
        }
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
        self.wrote(&settled);
        self.status = (!settled.committed).then_some(settled.refusal);
        self.undo = None;
        self.offer = None;
        self.said = false;
    }

    fn pin(&mut self, ctx: &Ctx) {
        if self.auto.draft().is_none() {
            return;
        }
        self.pinned = !self.pinned;
        self.forget_sentence();
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

    /// A TAG IS ITS OWN WRITE, sent at once under the note's id (`add-tag`,
    /// `remove-tag`): a choice, not typing. A note not yet created has nothing to
    /// tag, so the field is not offered then. The load after shows what committed.
    fn tag(&mut self, ctx: &Ctx, label: &str, adding: bool) {
        let label = label.trim();
        let Some(id) = self.note_id.clone() else {
            return;
        };
        if label.is_empty() {
            return;
        }
        let request: wire::ActRequest = if adding {
            act::notes::AddTag {
                note_id: id.clone(),
                label: label.to_owned(),
            }
            .into()
        } else {
            act::notes::RemoveTag {
                note_id: id.clone(),
                label: label.to_owned(),
            }
            .into()
        };
        let key = kit_act::key(&[&request.action.clone(), &id, label], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.wrote(&settled);
        self.status = (!settled.committed).then_some(settled.refusal);
        self.undo = None;
        self.offer = None;
        self.said = false;
        self.reload(ctx);
    }

    fn save_now(&mut self, ctx: &Ctx) {
        if self.saved(ctx, |auto, ctx| auto.flush(ctx)) {
            self.reload(ctx);
        }
        self.after_save(ctx);
    }

    fn body_edited(&mut self, ctx: &Ctx, after: String) {
        let Some(before) = self.auto.draft().map(|draft| draft.body.clone()) else {
            return;
        };
        // The shell has applied any caret it was told to place.
        self.selection = None;
        if before != after {
            self.forget_sentence();
        }
        self.auto.edit(ctx, |draft| draft.body.clone_from(&after));
        if let Some((anchor, replaces)) = bracket_opened(&before, &after) {
            self.open_link(ctx, anchor, replaces);
        }
        self.resolve(ctx);
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
        self.forget_sentence();
        self.auto.edit(ctx, |draft| draft.body = spliced);
        self.resolve(ctx);
    }

    fn event(&mut self, event: wire::NotesEditorEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(N::Title(edited)) => self.auto.edit(ctx, |draft| draft.title = edited.title),
            Some(N::Body(edited)) => self.body_edited(ctx, edited.body),
            Some(N::Pin(_)) => self.pin(ctx),
            Some(N::ChecklistRequested(_)) => self.checklist(ctx),
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
                        return Vec::new();
                    }
                    sheet.term = typed.term;
                    self.read_links(ctx);
                }
            }
            Some(N::LinkPicked(picked)) => self.pick_link(ctx, &picked.id),
            Some(N::LinkDismissed(_)) => self.link = None,
            Some(N::Refreshed(_)) => {
                self.own.clear();
                self.reload_all(ctx);
            }
            Some(N::ChecklistToggled(tapped)) => self.toggle(ctx, tapped.at),
            Some(N::StatusActed(_)) => {
                return match self.offer.take() {
                    Some(offer) => self.accept(ctx, offer),
                    None => {
                        self.undo(ctx);
                        Vec::new()
                    }
                };
            }
            Some(N::LinkOpened(opened)) => return self.open_chip(ctx, opened.at),
            Some(N::ReturnPressed(pressed)) => self.return_pressed(ctx, pressed.caret),
            Some(N::Save(_)) => self.save_now(ctx),
            Some(N::TagAdded(added)) => self.tag(ctx, &added.label, true),
            Some(N::TagRemoved(removed)) => self.tag(ctx, &removed.label, false),
            None => {}
        }
        Vec::new()
    }

    /// The vault changed under this screen. Our own commit (every table has a
    /// mark, see [`Editor::own`]) reads the note again and keeps what the
    /// typed titles meant; anything else is foreign and forgets it.
    fn data_changed(&mut self, ctx: &Ctx, tables: &[String]) {
        let mut foreign = tables.is_empty();
        for table in tables {
            foreign |= !self.own.remove(table);
        }
        if foreign {
            self.reload_all(ctx);
        } else if self.note_id.is_some() {
            self.reload(ctx);
        }
    }

    /// A reload event from elsewhere: a note may have been renamed, trashed or
    /// restored, so what the typed titles meant is forgotten and read again.
    fn reload_all(&mut self, ctx: &Ctx) {
        if self.note_id.is_some() {
            self.resolutions.clear();
            self.reload(ctx);
        }
    }

    /// The draft body drawn, every `[[title]]` as the cache last read it.
    fn rich_view(&self, locale: Locale, rich: &rich::Rich) -> wire::NotesRichText {
        let range = |range: rich::Range| wire::NotesTextRange {
            start: range.start,
            end: range.end,
        };
        let blocks = rich
            .blocks
            .iter()
            .map(|block| {
                use rich::BlockKind as K;
                let kind = match block.kind {
                    K::Paragraph => wire::NotesRichBlockKind::Paragraph,
                    K::Heading => wire::NotesRichBlockKind::Heading,
                    K::Checklist => wire::NotesRichBlockKind::Checklist,
                    K::Bullet => wire::NotesRichBlockKind::Bullet,
                    K::Quote => wire::NotesRichBlockKind::Quote,
                };
                wire::NotesRichBlock {
                    kind: kind.into(),
                    range: Some(range(block.range)),
                    marker: block.marker.map(range),
                    content: Some(range(block.content)),
                    level: block.level,
                    checked: block.checked,
                    accessibility_label: match (block.kind, block.checked) {
                        (K::Checklist, true) => words::checklist_checked(locale),
                        (K::Checklist, false) => words::checklist_unchecked(locale),
                        _ => String::new(),
                    },
                }
            })
            .collect();
        let spans = rich
            .spans
            .iter()
            .map(|span| {
                use rich::SpanStyle as S;
                let style = match span.style {
                    S::Emphasis => wire::NotesRichStyle::Emphasis,
                    S::Strong => wire::NotesRichStyle::Strong,
                    S::Strike => wire::NotesRichStyle::Strike,
                    S::Code => wire::NotesRichStyle::Code,
                    S::Syntax => wire::NotesRichStyle::Syntax,
                    S::Link => wire::NotesRichStyle::Link,
                };
                wire::NotesRichSpan {
                    style: style.into(),
                    range: Some(range(span.range)),
                    chip: span.link.as_ref().map(|link| self.chip(locale, link)),
                }
            })
            .collect();
        wire::NotesRichText {
            blocks,
            spans,
            truncated: rich.truncated,
            body_length: rich.length,
        }
    }

    fn chip(&self, locale: Locale, link: &rich::Link) -> wire::NotesLinkChip {
        let spoken =
            |template: String, label: &str| fill(&template, &[("title", label), ("label", label)]);
        match &link.target {
            LinkTarget::Url(_) => wire::NotesLinkChip {
                kind: wire::NotesLinkChipKind::Url.into(),
                label: link.label.clone(),
                resolution: wire::NotesLinkResolution::Resolved.into(),
                route: None,
                accessibility_label: spoken(words::link_web_spoken(locale), &link.label),
            },
            LinkTarget::Wiki(typed) => {
                let (label, resolution, route, template) = match self.resolutions.get(typed) {
                    Some(Resolution::Resolved { id, title }) => (
                        if title.trim().is_empty() {
                            typed.clone()
                        } else {
                            title.clone()
                        },
                        wire::NotesLinkResolution::Resolved,
                        Some(routes::editor(id)),
                        words::link_note_spoken(locale),
                    ),
                    Some(Resolution::Trashed { .. }) => (
                        typed.clone(),
                        wire::NotesLinkResolution::Trashed,
                        None,
                        words::link_trashed_spoken(locale),
                    ),
                    _ => (
                        typed.clone(),
                        wire::NotesLinkResolution::Missing,
                        None,
                        words::link_missing_spoken(locale),
                    ),
                };
                wire::NotesLinkChip {
                    kind: wire::NotesLinkChipKind::Note.into(),
                    accessibility_label: spoken(template, &label),
                    label,
                    resolution: resolution.into(),
                    route,
                }
            }
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
                wire::notes_link_sheet::Content::Data(wire::NotesLinkData { domains, empty })
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
            Some(E::DataChanged(changed)) => self.data_changed(ctx, &changed.tables),
            Some(E::EnvironmentChanged(_)) => {
                self.own.clear();
                self.reload_all(ctx);
            }
            Some(E::TimerFired(fired)) => {
                if self.saved(ctx, |auto, ctx| auto.fired(ctx, &fired.timer)) {
                    self.reload(ctx);
                }
                self.after_save(ctx);
            }
            // CLOSE = DONE: leaving saves what is unsaved.
            Some(E::Left(_)) => self.save_now(ctx),
            Some(E::NotesEditor(event)) => return self.event(event, ctx),
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
            (Some(draft), None, None) => {
                wire::notes_editor_state::Content::Draft(wire::NotesEditorDraft {
                    title: draft.title.clone(),
                    body: draft.body.clone(),
                    pinned: self.pinned,
                })
            }
            (None, None, None) => {
                wire::notes_editor_state::Content::Loading(wire::Loading { first_load: true })
            }
        };
        let phase =
            wire::autosave::Phase::try_from(autosave.phase).unwrap_or(wire::autosave::Phase::Clean);
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
                status: if autosave.refused {
                    save_status
                } else {
                    self.read_failure
                        .clone()
                        .or_else(|| self.status.clone())
                        .unwrap_or(save_status)
                },
                // Undo, or a dead link's Create or Restore, is offered while its sentence is the
                // one shown.
                status_action: if (self.undo.is_some() || self.offer.is_some())
                    && !autosave.refused
                    && self.read_failure.is_none()
                    && self.status.is_some()
                {
                    match &self.offer {
                        Some(Offer::Create { .. }) => words::link_create(locale),
                        Some(Offer::Restore { .. }) => words::link_restore(locale),
                        None => words::undo(locale),
                    }
                } else {
                    String::new()
                },
                title: if exists {
                    words::note_title(locale)
                } else {
                    words::new_note(locale)
                },
                menu_label: words::row_menu(locale),
                history_enabled: exists && draft.is_some(),
                retry: words::retry(locale),
                // Tags belong to a note, so the field waits for the first save.
                tag_placeholder: if exists {
                    words::tag_placeholder(locale)
                } else {
                    String::new()
                },
                checklist_label: words::checklist(locale),
                keyboard_label: words::keyboard_hide(locale),
            }),
            autosave: Some(autosave),
            link: self
                .link
                .as_ref()
                .map(|sheet| self.sheet_view(locale, sheet)),
            history: None,
            send_to_agenda: None,
            meta: if exists {
                self.meta.clone()
            } else {
                String::new()
            },
            tags: self
                .tags
                .iter()
                .map(|(concept_id, label)| wire::NotesEditorTag {
                    concept_id: concept_id.clone(),
                    label: label.clone(),
                    remove_label: words::remove_tag(locale),
                })
                .collect(),
            rich: None,
            selection: self.selection.map(|caret| wire::NotesEditorSelection {
                caret,
                seq: self.selection_seq,
            }),
        };
        if let (Some(draft), None, None) = (draft, &self.blocked, &self.denied) {
            state.rich = Some(self.rich_view(locale, &rich::parse(&draft.body)));
        }
        if let Some(id) = draft.and_then(|draft| draft.id.as_deref()) {
            state.history = Some(routes::history(id, &title));
        }
        // SEND TO AGENDA: To-do's quick add, the words waiting in it (the Inbox
        // is where they land). Nothing is written until the member adds them.
        if !agenda_words.trim().is_empty() {
            state.send_to_agenda = Some(routes::send_to_agenda(agenda_words.trim()));
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

    /// The Driver supplies a real vault; only its read/write failure seam is replaced.
    struct Flaky<'a> {
        core: &'a centraid_core::Handle,
        fail_reads: std::cell::Cell<bool>,
        fail_writes: std::cell::Cell<bool>,
        /// `link-targets` and `trash` reads made through this ctx.
        links: std::cell::Cell<usize>,
        trashes: std::cell::Cell<usize>,
        /// The tables the acts made through this ctx wrote, in order.
        written: std::cell::RefCell<Vec<String>>,
    }

    impl<'a> Flaky<'a> {
        fn new(core: &'a centraid_core::Handle) -> Self {
            Self {
                core,
                fail_reads: false.into(),
                fail_writes: false.into(),
                links: 0.into(),
                trashes: 0.into(),
                written: Vec::new().into(),
            }
        }
    }

    impl centraid_core::screens::ScreenCtx for Flaky<'_> {
        fn load(&self, request: &wire::LoadRequest) -> centraid_core::Result<wire::LoadResponse> {
            match request.query.as_str() {
                "link-targets" => self.links.set(self.links.get() + 1),
                "trash" => self.trashes.set(self.trashes.get() + 1),
                _ => {}
            }
            if self.fail_reads.get() {
                Err(centraid_core::CoreError::Unavailable {
                    reason: "test read failure".into(),
                })
            } else {
                self.core.load(request)
            }
        }

        fn act(&self, request: &wire::ActRequest) -> centraid_core::Result<wire::ActResponse> {
            if self.fail_writes.get() {
                Err(centraid_core::CoreError::Unavailable {
                    reason: "test write failure".into(),
                })
            } else {
                let response = self.core.act(request)?;
                self.written.borrow_mut().extend(response.tables.clone());
                Ok(response)
            }
        }

        fn push(&self, _update: wire::ScreenUpdate) {}
        fn wake_after(&self, _after: std::time::Duration) {}
    }

    #[test]
    fn a_failed_reread_preserves_dirty_words_and_a_refused_save_can_be_retried() {
        let driver = crate::testing::Driver::with_runtime(super::super::runtime());
        let mut request: wire::ActRequest = act::notes::CreateNote {
            title: "Keep".into(),
            body: "before".into(),
            ..Default::default()
        }
        .into();
        request.invoke_key = format!("test:{}", kit_act::fresh());
        let created = driver.act(request);
        let output: serde_json::Value =
            serde_json::from_slice(&created.output).expect("create output");
        let id = output["id"].as_str().expect("created id");
        let core = Flaky::new(&driver.handle);
        let env = crate::screen::Environment::default();
        let ctx = Ctx::new(&core, &env);
        let mut screen = build(&routes::editor(id)).expect("editor");
        let send = |screen: &mut Box<dyn Screen>, kind| {
            screen.update(wire::ScreenEvent { kind: Some(kind) }, &ctx);
        };
        send(&mut screen, E::Appeared(wire::Appeared {}));
        send(
            &mut screen,
            E::NotesEditor(wire::NotesEditorEvent {
                kind: Some(N::Body(wire::notes_editor_event::BodyEdited {
                    body: "only copy".into(),
                })),
            }),
        );
        core.fail_reads.set(true);
        send(&mut screen, E::DataChanged(wire::DataChanged::default()));
        let state = screen.view(&ctx);
        let Some(wire::view_state::Kind::NotesEditor(state)) = state.kind else {
            panic!("editor state")
        };
        assert!(
            matches!(state.content, Some(wire::notes_editor_state::Content::Draft(ref draft)) if draft.body == "only copy")
        );
        assert_eq!(
            state.chrome.expect("chrome").status,
            "Couldn't read this. Try again."
        );
        core.fail_writes.set(true);
        send(
            &mut screen,
            E::TimerFired(wire::TimerFired {
                timer: crate::kit::autosave::TIMER.into(),
            }),
        );
        let state = screen.view(&ctx);
        let Some(wire::view_state::Kind::NotesEditor(state)) = state.kind else {
            panic!("editor state")
        };
        assert!(state.autosave.expect("autosave").refused);
        assert!(
            matches!(state.content, Some(wire::notes_editor_state::Content::Draft(ref draft)) if draft.body == "only copy")
        );
        core.fail_writes.set(false);
        send(&mut screen, E::Left(wire::Left {}));
        core.fail_reads.set(false);
        let stored = driver
            .handle
            .load(&load::notes::Note { note_id: id.into() }.into())
            .expect("stored note");
        let Some(Answer::NotesNote(note)) = stored.answer.and_then(|answer| answer.answer) else {
            panic!("note answer")
        };
        assert_eq!(note.body, "only copy");
    }

    #[test]
    fn a_link_is_its_own_word() {
        assert_eq!(
            splice_link("Middlemarch.", 12, false, "Book"),
            "Middlemarch. [[Book]]"
        );
        assert_eq!(splice_link("", 0, false, "Book"), "[[Book]]");
        assert_eq!(
            splice_link("# Heading", 9, false, "Book"),
            "# Heading\n[[Book]]"
        );
        assert_eq!(splice_link("one\n", 4, false, "Book"), "one\n[[Book]]");
        assert_eq!(
            splice_link("see [[ now", 4, true, "Book"),
            "see [[Book]] now"
        );
        assert_eq!(splice_link("ab", 1, false, "X"), "a [[X]] b");
    }

    #[test]
    fn typing_two_brackets_opens_the_powerbox_once() {
        assert_eq!(bracket_opened("see ", "see [["), Some((4, true)));
        assert_eq!(bracket_opened("see [", "see [["), Some((4, true)));
        assert_eq!(bracket_opened("see [[x]]", "see [[x]]!"), None);
        assert_eq!(bracket_opened("", "plain"), None);
    }

    fn draft(id: Option<&str>, title: &str, body: &str) -> NoteDraft {
        NoteDraft {
            id: id.map(str::to_owned),
            title: title.into(),
            body: body.into(),
        }
    }

    fn sent(request: &wire::ActRequest) -> Vec<String> {
        let mut keys: Vec<String> = request.input.keys().cloned().collect();
        keys.sort();
        keys
    }

    #[test]
    fn only_the_changed_fields_are_sent() {
        let base = draft(Some("n1"), "Old", "words");
        // The title alone.
        let request = draft(Some("n1"), "New", "words").request(&base).unwrap();
        assert_eq!(request.action, "edit-note");
        assert_eq!(sent(&request), ["id", "title"]);
        // The body alone.
        let request = draft(Some("n1"), "Old", "more words")
            .request(&base)
            .unwrap();
        assert_eq!(sent(&request), ["body", "id"]);
        // Nothing changed: nothing to send.
        assert!(base.request(&base).is_none());
        // A body cleared to nothing is the member's words.
        let request = draft(Some("n1"), "Old", "").request(&base).unwrap();
        assert_eq!(sent(&request), ["body", "id"]);
    }

    #[test]
    fn an_untitled_note_is_titled_from_its_first_line() {
        let base = draft(Some("n1"), "", "old line");
        let request = draft(Some("n1"), "", "\n  Shopping list \nmilk")
            .request(&base)
            .unwrap();
        assert_eq!(sent(&request), ["body", "id", "title"]);
        assert_eq!(
            request.input["title"].kind,
            Some(wire::value::Kind::Text("Shopping list".to_owned()))
        );
    }

    #[test]
    fn a_new_note_is_created_whole_and_learns_its_id_from_the_output() {
        let mut fresh = draft(None, "Groceries", "milk");
        let request = fresh.request(&draft(None, "", "")).unwrap();
        assert_eq!(request.action, "create-note");
        assert_eq!(sent(&request), ["body", "format", "title"]);
        fresh.committed(br#"{"id":"n-9"}"#);
        assert_eq!(fresh.id.as_deref(), Some("n-9"));
        // From now on it is an edit of that note.
        let after = draft(Some("n-9"), "Groceries", "milk and eggs");
        assert_eq!(after.request(&fresh).unwrap().action, "edit-note");
        // An output that names no id leaves the draft new.
        let mut stubborn = draft(None, "x", "y");
        stubborn.committed(b"{}");
        assert!(stubborn.id.is_none());
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

    // ---- the rich view, core edits and wiki resolution ----

    use crate::testing::Driver;

    fn make(driver: &Driver, title: &str, body: &str) -> String {
        let mut request: wire::ActRequest = act::notes::CreateNote {
            title: title.into(),
            body: body.into(),
            ..Default::default()
        }
        .into();
        request.invoke_key = format!("test:{}", kit_act::fresh());
        let created = driver.act(request);
        let output: serde_json::Value = serde_json::from_slice(&created.output).expect("output");
        output["id"].as_str().expect("id").to_owned()
    }

    fn trash(driver: &Driver, id: &str) {
        let mut request: wire::ActRequest = act::notes::DeleteNote { note_id: id.into() }.into();
        request.invoke_key = format!("test:{}", kit_act::fresh());
        assert_eq!(driver.act(request).status, wire::ActStatus::Executed as i32);
    }

    fn stored_body(driver: &Driver, id: &str) -> String {
        let stored = driver
            .handle
            .load(&load::notes::Note { note_id: id.into() }.into())
            .expect("stored note");
        let Some(Answer::NotesNote(note)) = stored.answer.and_then(|answer| answer.answer) else {
            panic!("note answer")
        };
        note.body
    }

    fn send(screen: &mut Box<dyn Screen>, ctx: &Ctx, kind: E) -> Vec<wire::Effect> {
        screen.update(wire::ScreenEvent { kind: Some(kind) }, ctx)
    }

    fn ev(screen: &mut Box<dyn Screen>, ctx: &Ctx, kind: N) -> Vec<wire::Effect> {
        send(
            screen,
            ctx,
            E::NotesEditor(wire::NotesEditorEvent { kind: Some(kind) }),
        )
    }

    fn typed(screen: &mut Box<dyn Screen>, ctx: &Ctx, body: &str) {
        ev(
            screen,
            ctx,
            N::Body(wire::notes_editor_event::BodyEdited { body: body.into() }),
        );
    }

    fn tap(screen: &mut Box<dyn Screen>, ctx: &Ctx, at: u32) {
        ev(
            screen,
            ctx,
            N::ChecklistToggled(wire::notes_editor_event::ChecklistToggled { at }),
        );
    }

    fn undo(screen: &mut Box<dyn Screen>, ctx: &Ctx) {
        ev(
            screen,
            ctx,
            N::StatusActed(wire::notes_editor_event::StatusActed {}),
        );
    }

    fn state(screen: &dyn Screen, ctx: &Ctx) -> wire::NotesEditorState {
        let Some(wire::view_state::Kind::NotesEditor(state)) = screen.view(ctx).kind else {
            panic!("editor state")
        };
        state
    }

    fn body_of(state: &wire::NotesEditorState) -> String {
        match &state.content {
            Some(wire::notes_editor_state::Content::Draft(draft)) => draft.body.clone(),
            other => panic!("no draft: {other:?}"),
        }
    }

    fn opened<'a>(core: &'a Flaky, id: &str) -> (Box<dyn Screen>, Ctx<'a>) {
        let env: &'static crate::screen::Environment =
            Box::leak(Box::new(crate::screen::Environment::default()));
        let ctx = Ctx::new(core, env);
        let mut screen = build(&routes::editor(id)).expect("editor");
        send(&mut screen, &ctx, E::Appeared(wire::Appeared {}));
        (screen, ctx)
    }

    fn chips(state: &wire::NotesEditorState) -> Vec<wire::NotesLinkChip> {
        state
            .rich
            .as_ref()
            .expect("rich")
            .spans
            .iter()
            .filter_map(|span| span.chip.clone())
            .collect()
    }

    #[test]
    fn the_view_carries_blocks_spans_and_labels() {
        let driver = Driver::with_runtime(super::super::runtime());
        let body = "# Plan\n- [x] done\n- [ ] todo\nsome **bold** and https://example.com/a b\n[docs](https://example.org)";
        let id = make(&driver, "T", body);
        let core = Flaky::new(&driver.handle);
        let (screen, ctx) = opened(&core, &id);
        let state = state(&*screen, &ctx);
        let rich = state.rich.clone().expect("rich");
        assert_eq!(rich.body_length, body.encode_utf16().count() as u32);
        assert!(!rich.truncated);
        let kinds: Vec<i32> = rich.blocks.iter().map(|b| b.kind).collect();
        assert_eq!(
            kinds,
            [
                wire::NotesRichBlockKind::Heading as i32,
                wire::NotesRichBlockKind::Checklist as i32,
                wire::NotesRichBlockKind::Checklist as i32,
                wire::NotesRichBlockKind::Paragraph as i32,
                wire::NotesRichBlockKind::Paragraph as i32,
            ]
        );
        assert_eq!(rich.blocks[0].level, 1);
        assert_eq!(
            rich.blocks[0].range,
            Some(wire::NotesTextRange { start: 0, end: 6 })
        );
        assert_eq!(
            rich.blocks[1].marker,
            Some(wire::NotesTextRange { start: 9, end: 12 })
        );
        assert!(rich.blocks[1].checked);
        assert_eq!(rich.blocks[1].accessibility_label, "Checked");
        assert!(!rich.blocks[2].checked);
        assert_eq!(rich.blocks[2].accessibility_label, "Not checked");
        assert!(rich.blocks[3].marker.is_none());
        assert_eq!(rich.blocks[3].accessibility_label, "");
        assert!(
            rich.spans
                .iter()
                .any(|span| span.style == wire::NotesRichStyle::Strong as i32)
        );
        let chips = chips(&state);
        assert_eq!(chips.len(), 2);
        assert_eq!(chips[0].kind, wire::NotesLinkChipKind::Url as i32);
        assert_eq!(
            chips[0].resolution,
            wire::NotesLinkResolution::Resolved as i32
        );
        assert!(chips[0].route.is_none());
        assert_eq!(
            chips[0].accessibility_label,
            format!("Link {}", chips[0].label)
        );
        assert_eq!(chips[1].label, "docs");
    }

    #[test]
    fn ranges_are_utf16_units_after_an_emoji() {
        let driver = Driver::with_runtime(super::super::runtime());
        let body = "😀 [docs](https://example.org)";
        let id = make(&driver, "T", body);
        let core = Flaky::new(&driver.handle);
        let (screen, ctx) = opened(&core, &id);
        let rich = state(&*screen, &ctx).rich.expect("rich");
        assert_eq!(rich.body_length, 2 + 1 + 27);
        let link = rich
            .spans
            .iter()
            .find(|span| span.style == wire::NotesRichStyle::Link as i32)
            .expect("link span");
        let range = link.range.expect("range");
        assert_eq!(range.start, 3);
        assert!(range.end <= rich.body_length);
    }

    #[test]
    fn a_tap_checks_an_item_saves_it_and_undo_takes_it_back() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "- [ ] milk\n- [ ] eggs");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        tap(&mut screen, &ctx, 4);
        let view = state(&*screen, &ctx);
        assert_eq!(body_of(&view), "- [x] milk\n- [ ] eggs");
        let chrome = view.chrome.expect("chrome");
        assert_eq!(chrome.status, "Item checked");
        assert_eq!(chrome.status_action, "Undo");
        send(&mut screen, &ctx, E::Left(wire::Left {}));
        assert_eq!(stored_body(&driver, &id), "- [x] milk\n- [ ] eggs");

        undo(&mut screen, &ctx);
        let view = state(&*screen, &ctx);
        assert_eq!(body_of(&view), "- [ ] milk\n- [ ] eggs");
        let chrome = view.chrome.expect("chrome");
        assert_eq!(chrome.status_action, "");
        assert_ne!(chrome.status, "Item checked");
        // A second Undo does nothing.
        undo(&mut screen, &ctx);
        assert_eq!(body_of(&state(&*screen, &ctx)), "- [ ] milk\n- [ ] eggs");
        send(&mut screen, &ctx, E::Left(wire::Left {}));
        assert_eq!(stored_body(&driver, &id), "- [ ] milk\n- [ ] eggs");
    }

    #[test]
    fn unchecking_says_so() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "- [x] milk");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        tap(&mut screen, &ctx, 0);
        let view = state(&*screen, &ctx);
        assert_eq!(body_of(&view), "- [ ] milk");
        assert_eq!(view.chrome.expect("chrome").status, "Item unchecked");
    }

    #[test]
    fn undo_after_the_item_was_edited_away_does_nothing() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "- [ ] milk");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        tap(&mut screen, &ctx, 0);
        typed(&mut screen, &ctx, "milk");
        let view = state(&*screen, &ctx);
        assert_eq!(view.chrome.expect("chrome").status_action, "");
        undo(&mut screen, &ctx);
        assert_eq!(body_of(&state(&*screen, &ctx)), "milk");
    }

    #[test]
    fn a_tap_off_a_checklist_changes_nothing() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "plain\n- [ ] item");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        tap(&mut screen, &ctx, 2);
        let view = state(&*screen, &ctx);
        assert_eq!(body_of(&view), "plain\n- [ ] item");
        let chrome = view.chrome.expect("chrome");
        assert_eq!(chrome.status_action, "");
        assert_eq!(chrome.status, "");
    }

    #[test]
    fn a_toggle_round_trip_keeps_crlf() {
        let driver = Driver::with_runtime(super::super::runtime());
        let body = "- [ ] a\r\n- [ ] b\r\n";
        let id = make(&driver, "T", body);
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        tap(&mut screen, &ctx, 12);
        assert_eq!(body_of(&state(&*screen, &ctx)), "- [ ] a\r\n- [x] b\r\n");
        undo(&mut screen, &ctx);
        assert_eq!(body_of(&state(&*screen, &ctx)), body);
    }

    fn pressed(screen: &mut Box<dyn Screen>, ctx: &Ctx, caret: u32) {
        ev(
            screen,
            ctx,
            N::ReturnPressed(wire::notes_editor_event::ReturnPressed { caret }),
        );
    }

    #[test]
    fn return_continues_a_checklist_and_moves_the_caret() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "- [x] milk");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        pressed(&mut screen, &ctx, 10);
        let view = state(&*screen, &ctx);
        assert_eq!(body_of(&view), "- [x] milk\n- [ ] ");
        let selection = view.selection.expect("selection");
        assert_eq!(selection.caret, 17);
        assert_eq!(selection.seq, 1);
        // The shell applied it: the next edit clears it.
        typed(&mut screen, &ctx, "- [x] milk\n- [ ] e");
        assert!(state(&*screen, &ctx).selection.is_none());
        // The next Return is a new seq.
        pressed(&mut screen, &ctx, 18);
        assert_eq!(state(&*screen, &ctx).selection.expect("selection").seq, 2);
    }

    #[test]
    fn return_on_an_empty_item_ends_the_list_and_on_a_plain_line_adds_a_newline() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "- [ ] ");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        pressed(&mut screen, &ctx, 6);
        let view = state(&*screen, &ctx);
        assert_eq!(body_of(&view), "");
        assert_eq!(view.selection.expect("selection").caret, 0);
        typed(&mut screen, &ctx, "hello");
        pressed(&mut screen, &ctx, 5);
        assert_eq!(body_of(&state(&*screen, &ctx)), "hello\n");
    }

    #[test]
    fn return_does_not_open_the_powerbox() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "- [ ] see [");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        pressed(&mut screen, &ctx, 11);
        assert!(state(&*screen, &ctx).link.is_none());
    }

    fn opened_link(screen: &mut Box<dyn Screen>, ctx: &Ctx, at: u32) -> Vec<wire::Effect> {
        ev(
            screen,
            ctx,
            N::LinkOpened(wire::notes_editor_event::LinkOpened { at }),
        )
    }

    #[test]
    fn wiki_chips_resolve_to_live_trashed_and_missing_notes() {
        let driver = Driver::with_runtime(super::super::runtime());
        let live = make(&driver, "Lisbon itinerary", "trip");
        let old = make(&driver, "Old plan", "x");
        trash(&driver, &old);
        let body = "[[lisbon itinerary]] [[Old plan]] [[Nowhere]] [[ ]]";
        let id = make(&driver, "Host", body);
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        let view = state(&*screen, &ctx);
        let chips = chips(&view);
        assert_eq!(chips.len(), 3, "{chips:?}");
        assert_eq!(chips[0].label, "Lisbon itinerary");
        assert_eq!(
            chips[0].resolution,
            wire::NotesLinkResolution::Resolved as i32
        );
        assert_eq!(chips[0].route, Some(routes::editor(&live)));
        assert_eq!(chips[0].accessibility_label, "Note Lisbon itinerary");
        assert_eq!(chips[1].label, "Old plan");
        assert_eq!(
            chips[1].resolution,
            wire::NotesLinkResolution::Trashed as i32
        );
        assert!(chips[1].route.is_none());
        assert_eq!(chips[1].accessibility_label, "Note in trash Old plan");
        assert_eq!(chips[2].label, "Nowhere");
        assert_eq!(
            chips[2].resolution,
            wire::NotesLinkResolution::Missing as i32
        );
        assert_eq!(chips[2].accessibility_label, "Missing note Nowhere");

        let starts: Vec<u32> = view
            .rich
            .expect("rich")
            .spans
            .iter()
            .filter(|span| span.chip.is_some())
            .map(|span| span.range.expect("range").start)
            .collect();
        // A live note's tap is the shell's: no effect, no sentence.
        assert!(opened_link(&mut screen, &ctx, starts[0]).is_empty());
        assert_eq!(state(&*screen, &ctx).chrome.expect("chrome").status, "");
        assert!(opened_link(&mut screen, &ctx, starts[2]).is_empty());
        let chrome = state(&*screen, &ctx).chrome.expect("chrome");
        assert_eq!(chrome.status, "No note called Nowhere");
        assert_eq!(chrome.status_action, "Create note");
        assert!(opened_link(&mut screen, &ctx, starts[1]).is_empty());
        let chrome = state(&*screen, &ctx).chrome.expect("chrome");
        assert_eq!(chrome.status, "Old plan is in the trash");
        assert_eq!(chrome.status_action, "Restore");
        // Typing takes the sentence away.
        typed(&mut screen, &ctx, "x");
        assert_eq!(state(&*screen, &ctx).chrome.expect("chrome").status, "");
    }

    fn chip_starts(screen: &dyn Screen, ctx: &Ctx) -> Vec<u32> {
        state(screen, ctx)
            .rich
            .expect("rich")
            .spans
            .iter()
            .filter(|span| span.chip.is_some())
            .map(|span| span.range.expect("range").start)
            .collect()
    }

    fn opens_editor(effects: &[wire::Effect]) -> Option<String> {
        effects.iter().find_map(|effect| match &effect.kind {
            Some(wire::effect::Kind::OpenRoute(open)) => match open.route.as_ref()?.args.as_ref()? {
                wire::route::Args::NotesEditor(args) => Some(args.note_id.clone()),
                _ => None,
            },
            _ => None,
        })
    }

    #[test]
    fn a_link_to_a_missing_note_offers_to_make_it_and_opens_it() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "Host", "see [[Packing list]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        let at = chip_starts(&*screen, &ctx)[0];
        assert!(opened_link(&mut screen, &ctx, at).is_empty());
        let chrome = state(&*screen, &ctx).chrome.expect("chrome");
        assert_eq!(chrome.status, "No note called Packing list");
        assert_eq!(chrome.status_action, "Create note");
        // The verb makes the note, opens it, and the chip now resolves to it.
        let effects = ev(
            &mut screen,
            &ctx,
            N::StatusActed(wire::notes_editor_event::StatusActed {}),
        );
        let made = opens_editor(&effects).expect("the new note opens");
        let view = state(&*screen, &ctx);
        let chrome = view.chrome.clone().expect("chrome");
        assert_eq!(chrome.status_action, "");
        let chips = chips(&view);
        assert_eq!(chips[0].resolution, wire::NotesLinkResolution::Resolved as i32);
        assert_eq!(chips[0].route, Some(routes::editor(&made)));
        // Exactly one note by that name now exists, and it is the one that opened.
        let again = ev(
            &mut screen,
            &ctx,
            N::StatusActed(wire::notes_editor_event::StatusActed {}),
        );
        assert!(again.is_empty(), "the offer is spent");
    }

    #[test]
    fn a_link_to_a_trashed_note_offers_to_restore_it_and_opens_it() {
        let driver = Driver::with_runtime(super::super::runtime());
        let old = make(&driver, "Old plan", "x");
        trash(&driver, &old);
        let id = make(&driver, "Host", "see [[Old plan]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        let at = chip_starts(&*screen, &ctx)[0];
        opened_link(&mut screen, &ctx, at);
        let chrome = state(&*screen, &ctx).chrome.expect("chrome");
        assert_eq!(chrome.status, "Old plan is in the trash");
        assert_eq!(chrome.status_action, "Restore");
        let effects = ev(
            &mut screen,
            &ctx,
            N::StatusActed(wire::notes_editor_event::StatusActed {}),
        );
        assert_eq!(opens_editor(&effects), Some(old.clone()));
        let view = state(&*screen, &ctx);
        let chips = chips(&view);
        assert_eq!(chips[0].resolution, wire::NotesLinkResolution::Resolved as i32);
        assert_eq!(chips[0].route, Some(routes::editor(&old)));
    }

    #[test]
    fn typing_takes_a_dead_links_offer_away_with_its_sentence() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "Host", "see [[Nowhere]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        let at = chip_starts(&*screen, &ctx)[0];
        opened_link(&mut screen, &ctx, at);
        typed(&mut screen, &ctx, "see [[Nowhere]] x");
        let chrome = state(&*screen, &ctx).chrome.expect("chrome");
        assert_eq!(chrome.status_action, "");
        let effects = ev(
            &mut screen,
            &ctx,
            N::StatusActed(wire::notes_editor_event::StatusActed {}),
        );
        assert!(effects.is_empty());
    }

    #[test]
    fn a_url_chip_opens_outside_and_an_unsafe_link_is_no_link() {
        let driver = Driver::with_runtime(super::super::runtime());
        let body = "[ok](https://example.org/x) [bad](javascript:alert(1))";
        let id = make(&driver, "T", body);
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        let view = state(&*screen, &ctx);
        let spans = view.rich.expect("rich").spans;
        let links: Vec<_> = spans.iter().filter(|s| s.chip.is_some()).collect();
        assert_eq!(links.len(), 1);
        let at = links[0].range.expect("range").start;
        let effects = opened_link(&mut screen, &ctx, at);
        assert_eq!(effects.len(), 1);
        assert_eq!(
            effects[0].kind,
            Some(wire::effect::Kind::OpenUrl(wire::OpenUrl {
                url: "https://example.org/x".into()
            }))
        );
        // Offset inside the unsafe text: nothing.
        let bad = body.find("[bad]").expect("bad") as u32 + 2;
        assert!(opened_link(&mut screen, &ctx, bad).is_empty());
    }

    #[test]
    fn resolution_reads_are_bounded_and_cached() {
        let driver = Driver::with_runtime(super::super::runtime());
        let body: String = (1..=40).map(|n| format!("[[t{n}]] ")).collect();
        let id = make(&driver, "T", &body);
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        assert!(core.links.get() <= 32, "{}", core.links.get());
        assert_eq!(core.links.get(), 32);
        assert_eq!(core.trashes.get(), 1);
        // Typing that adds no title reads nothing.
        let (links, trashes) = (core.links.get(), core.trashes.get());
        typed(&mut screen, &ctx, &format!("{body}more"));
        typed(&mut screen, &ctx, &format!("{body}more words"));
        assert_eq!(core.links.get(), links);
        assert_eq!(core.trashes.get(), trashes);
        // A reload event forgets and reads again, within the same bound.
        send(
            &mut screen,
            &ctx,
            E::DataChanged(wire::DataChanged::default()),
        );
        assert_eq!(core.links.get() - links, 32);
        assert_eq!(core.trashes.get() - trashes, 1);
    }

    /// What the core does after a commit: one `DataChanged` per table.
    fn deliver(screen: &mut Box<dyn Screen>, ctx: &Ctx, tables: &[String]) {
        for table in tables {
            send(
                screen,
                ctx,
                E::DataChanged(wire::DataChanged {
                    tables: vec![table.clone()],
                }),
            );
        }
    }

    fn act_now(driver: &Driver, request: impl Into<wire::ActRequest>) -> Vec<String> {
        let mut request: wire::ActRequest = request.into();
        request.invoke_key = format!("test:{}", kit_act::fresh());
        let response = driver.act(request);
        assert_eq!(response.status, wire::ActStatus::Executed as i32);
        assert!(!response.tables.is_empty());
        response.tables
    }

    fn fire(screen: &mut Box<dyn Screen>, ctx: &Ctx) {
        send(
            screen,
            ctx,
            E::TimerFired(wire::TimerFired {
                timer: crate::kit::autosave::TIMER.into(),
            }),
        );
    }

    fn resolutions(screen: &dyn Screen, ctx: &Ctx) -> Vec<(String, i32)> {
        chips(&state(screen, ctx))
            .into_iter()
            .map(|chip| (chip.label, chip.resolution))
            .collect()
    }

    #[test]
    fn our_own_save_keeps_the_resolved_titles() {
        let driver = Driver::with_runtime(super::super::runtime());
        make(&driver, "Alpha", "x");
        let id = make(&driver, "Host", "[[Alpha]] [[Ghost]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        assert_eq!((core.links.get(), core.trashes.get()), (2, 1));
        typed(&mut screen, &ctx, "[[Alpha]] [[Ghost]] more");
        fire(&mut screen, &ctx);
        let written = core.written.borrow().clone();
        assert!(!written.is_empty(), "the save committed");
        // The change the core sends for our own commit, one per table.
        deliver(&mut screen, &ctx, &written);
        assert_eq!((core.links.get(), core.trashes.get()), (2, 1));
        assert_eq!(resolutions(&*screen, &ctx).len(), 2);
        // The marks are spent: the same tables changing again is foreign.
        deliver(&mut screen, &ctx, &written);
        assert_eq!(core.links.get(), 2 + 2 * written.len());
        assert_eq!(core.trashes.get(), 1 + written.len());
    }

    #[test]
    fn our_own_pin_keeps_the_resolved_titles() {
        let driver = Driver::with_runtime(super::super::runtime());
        make(&driver, "Alpha", "x");
        let id = make(&driver, "Host", "[[Alpha]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        assert_eq!(core.links.get(), 1);
        ev(
            &mut screen,
            &ctx,
            N::Pin(wire::notes_editor_event::PinToggled {}),
        );
        let written = core.written.borrow().clone();
        assert!(!written.is_empty());
        deliver(&mut screen, &ctx, &written);
        assert_eq!(core.links.get(), 1);
    }

    #[test]
    fn a_rename_or_a_trash_from_elsewhere_resolves_again_and_a_restore_too() {
        let driver = Driver::with_runtime(super::super::runtime());
        let alpha = make(&driver, "Alpha", "x");
        let id = make(&driver, "Host", "[[Alpha]] [[Ghost]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        let live = wire::NotesLinkResolution::Resolved as i32;
        assert_eq!(resolutions(&*screen, &ctx)[0], ("Alpha".into(), live));
        // Renamed elsewhere.
        let tables = act_now(
            &driver,
            act::notes::EditNote {
                note_id: alpha.clone(),
                title: Some("Alpha two".into()),
                ..Default::default()
            },
        );
        let (links, trashes) = (core.links.get(), core.trashes.get());
        deliver(&mut screen, &ctx, &tables);
        assert_eq!(core.links.get() - links, 2 * tables.len());
        assert_eq!(core.trashes.get() - trashes, tables.len());
        assert_eq!(
            resolutions(&*screen, &ctx)[0].1,
            wire::NotesLinkResolution::Missing as i32
        );
        // Renamed back, then trashed.
        act_now(
            &driver,
            act::notes::EditNote {
                note_id: alpha.clone(),
                title: Some("Alpha".into()),
                ..Default::default()
            },
        );
        let tables = act_now(
            &driver,
            act::notes::DeleteNote {
                note_id: alpha.clone(),
            },
        );
        let (links, trashes) = (core.links.get(), core.trashes.get());
        deliver(&mut screen, &ctx, &tables[..1]);
        assert_eq!(core.links.get() - links, 2);
        assert_eq!(core.trashes.get() - trashes, 1);
        assert_eq!(
            resolutions(&*screen, &ctx)[0].1,
            wire::NotesLinkResolution::Trashed as i32
        );
        // Restored.
        let tables = act_now(&driver, act::notes::RestoreNote { note_id: alpha });
        deliver(&mut screen, &ctx, &tables[..1]);
        assert_eq!(resolutions(&*screen, &ctx)[0].1, live);
    }

    #[test]
    fn our_save_that_renames_the_note_drops_only_its_own_titles() {
        let driver = Driver::with_runtime(super::super::runtime());
        make(&driver, "Alpha", "x");
        let id = make(&driver, "Host", "[[Host]] [[Alpha]] [[Renamed]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        assert_eq!((core.links.get(), core.trashes.get()), (3, 1));
        let live = wire::NotesLinkResolution::Resolved as i32;
        let missing = wire::NotesLinkResolution::Missing as i32;
        assert_eq!(
            resolutions(&*screen, &ctx),
            [
                ("Host".to_owned(), live),
                ("Alpha".to_owned(), live),
                ("Renamed".to_owned(), missing)
            ]
        );
        ev(
            &mut screen,
            &ctx,
            N::Title(wire::notes_editor_event::TitleEdited {
                title: "Renamed".into(),
            }),
        );
        fire(&mut screen, &ctx);
        // Only "Host" (old title, and its id) and "Renamed" (new title) read again.
        assert_eq!((core.links.get(), core.trashes.get()), (5, 2));
        assert_eq!(
            resolutions(&*screen, &ctx),
            [
                ("Host".to_owned(), missing),
                ("Alpha".to_owned(), live),
                ("Renamed".to_owned(), live)
            ]
        );
        let written = core.written.borrow().clone();
        deliver(&mut screen, &ctx, &written);
        assert_eq!((core.links.get(), core.trashes.get()), (5, 2));
    }

    #[test]
    fn the_cache_holds_only_the_titles_the_body_has() {
        let driver = Driver::with_runtime(super::super::runtime());
        make(&driver, "Alpha", "x");
        let id = make(&driver, "Host", "[[Alpha]]");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        assert_eq!(core.links.get(), 1);
        typed(&mut screen, &ctx, "[[Ghost]]");
        assert_eq!(core.links.get(), 2);
        typed(&mut screen, &ctx, "[[Alpha]]");
        assert_eq!(core.links.get(), 3, "Alpha was pruned, so it reads again");
        typed(&mut screen, &ctx, "[[Alpha]] x");
        assert_eq!(core.links.get(), 3);
    }

    #[test]
    fn a_failed_read_is_not_cached() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "[[Later]]");
        let core = Flaky::new(&driver.handle);
        core.fail_reads.set(true);
        let env = crate::screen::Environment::default();
        let ctx = Ctx::new(&core, &env);
        let mut screen = build(&routes::editor(&id)).expect("editor");
        send(&mut screen, &ctx, E::Appeared(wire::Appeared {}));
        core.fail_reads.set(false);
        // The first read failed: there is no draft yet, so the first success loads it.
        send(
            &mut screen,
            &ctx,
            E::DataChanged(wire::DataChanged::default()),
        );
        let chips = chips(&state(&*screen, &ctx));
        assert_eq!(
            chips[0].resolution,
            wire::NotesLinkResolution::Missing as i32
        );
        let before = core.links.get();
        typed(&mut screen, &ctx, "[[Later]] x");
        assert_eq!(core.links.get(), before, "a resolved miss is cached");
    }

    #[test]
    fn a_huge_body_is_truncated_not_swallowed() {
        let driver = Driver::with_runtime(super::super::runtime());
        let id = make(&driver, "T", "x");
        let core = Flaky::new(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        let huge = "- [ ] a\n".repeat(37_500);
        assert!(huge.len() >= 300_000);
        typed(&mut screen, &ctx, &huge);
        let rich = state(&*screen, &ctx).rich.expect("rich");
        assert!(rich.truncated);
        assert!(rich.blocks.len() <= rich::MAX_BLOCKS);
        assert_eq!(rich.body_length as usize, huge.len());
    }

    #[test]
    fn there_is_no_rich_text_without_a_draft() {
        let driver = Driver::with_runtime(super::super::runtime());
        let core = Flaky::new(&driver.handle);
        let env = crate::screen::Environment::default();
        let ctx = Ctx::new(&core, &env);
        let screen = build(&routes::editor("nothing")).expect("editor");
        assert!(state(&*screen, &ctx).rich.is_none());
    }
}
