//! ONE NOTE'S VERSIONS, newest first, the current one marked (`notes.history`).
//!
//! RESTORING IS A WRITE AND ASKS NOTHING: `note.restore_version` writes the
//! words it replaces as a NEW version, so a restore is itself undoable from this
//! list. A version's key is its revision's `seq`, as text. The vault's change
//! event, and the load after every write, re-read the list.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::notes_history_event::Kind as H;
use wire::screen_event::Kind as E;

use super::{Phase, denied, fold};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::civil;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, notes as words};

/// The characters of a version's body its row previews when it has no first line.
const PREVIEW: usize = 200;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::NotesHistory(args)) = &route.args else {
        return None;
    };
    Some(Box::new(History {
        note_id: args.note_id.clone(),
        note_title: args.note_title.clone(),
        phase: Phase::Loading,
        status: None,
    }))
}

struct History {
    note_id: String,
    note_title: String,
    phase: Phase<wire::NotesHistory>,
    /// A refusal's sentence, over the list.
    status: Option<wire::StatusLine>,
}

impl History {
    fn reload(&mut self, ctx: &Ctx) {
        // A history of nothing is not a read.
        if self.note_id.is_empty() {
            self.phase = Phase::Failed;
            return;
        }
        self.phase = Phase::of(read::read(
            ctx,
            load::notes::History {
                note_id: self.note_id.clone(),
            },
            |answer| match answer {
                Answer::NotesHistory(history) => Some(history),
                _ => None,
            },
        ));
    }

    /// The core's versions, as rows. The day and the time are the member's
    /// (`asserted_local_day`, `asserted_local`), read in the request's zone; an
    /// answer with no zone resolved says neither.
    fn rows(locale: Locale, history: &wire::NotesHistory) -> Vec<wire::NotesVersionRow> {
        history
            .versions
            .iter()
            .map(|version| {
                let day = if version.asserted_local_day.is_empty() {
                    version.asserted_local.get(..10).unwrap_or_default()
                } else {
                    version.asserted_local_day.as_str()
                };
                let dated = [
                    if day.is_empty() {
                        String::new()
                    } else {
                        civil::day_month(locale, day)
                    },
                    civil::clock(&version.asserted_local),
                ]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
                let label = if version.current {
                    words::current_version(locale)
                } else {
                    dated
                };
                let first = fold::first_line(&version.body);
                let preview = if first.is_empty() {
                    version.body.chars().take(PREVIEW).collect()
                } else {
                    first
                };
                wire::NotesVersionRow {
                    content_id: version.seq.to_string(),
                    accessibility_label: [label.as_str(), preview.as_str()]
                        .into_iter()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(", "),
                    restore_label: if version.current {
                        String::new()
                    } else {
                        words::restore(locale)
                    },
                    current: version.current,
                    label,
                    preview,
                }
            })
            .collect()
    }

    fn restore(&mut self, ctx: &Ctx, content_id: &str) {
        let Some(version) = self.phase.data().and_then(|history| {
            history
                .versions
                .iter()
                .find(|version| version.seq.to_string() == content_id)
        }) else {
            return;
        };
        if version.current || self.note_id.is_empty() {
            return;
        }
        let seq = version.seq;
        let key = kit_act::key(&["note.restore_version", &self.note_id], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::notes::RestoreNoteVersion {
                note_id: self.note_id.clone(),
                seq,
            },
            &key,
        );
        self.status = (!settled.committed).then(|| wire::StatusLine {
            sentence: settled.refusal,
            action_label: String::new(),
            refused: true,
        });
        self.reload(ctx);
    }
}

impl Screen for History {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::NotesHistory(event)) => match event.kind {
                Some(H::Refreshed(_)) => self.reload(ctx),
                Some(H::Restore(tapped)) => self.restore(ctx, &tapped.content_id),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => {
                wire::notes_history_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::notes_history_state::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => {
                wire::notes_history_state::Content::Denied(denied(locale, denial))
            }
            Phase::Ready(history) => {
                let rows = Self::rows(locale, history);
                // One version is the note as it is: there is nothing earlier.
                let empty = (rows.len() <= 1).then(|| wire::EmptyState {
                    headline: words::history_empty_headline(locale),
                    body: words::history_empty_body(locale),
                    ..wire::EmptyState::default()
                });
                wire::notes_history_state::Content::Data(wire::NotesHistoryData { rows, empty })
            }
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::NotesHistory(
                wire::NotesHistoryState {
                    note_id: self.note_id.clone(),
                    title: words::history_title(locale),
                    back: if self.note_title.trim().is_empty() {
                        words::untitled(locale)
                    } else {
                        self.note_title.clone()
                    },
                    close: words::close(locale),
                    retry: words::retry(locale),
                    loading_label: words::loading_history(locale),
                    content: Some(content),
                    status: self.status.clone(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
