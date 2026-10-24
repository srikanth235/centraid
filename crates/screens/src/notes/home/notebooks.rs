//! THE NOTEBOOKS PLACE: "Unfiled", then every notebook with its count, and a
//! sheet that creates or renames one. Picking a row opens the Notes place
//! filtered to it.
//!
//! ALBUMS NEVER ARRIVE: the core's read is of notebook collections, so nothing
//! here tells a notebook from an album.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::load;
use crate::kit::read;
use crate::notes::{Phase, fold};
use crate::screen::Ctx;
use crate::strings::{Locale, notes as words};

/// The id of the "Unfiled" row, which is no collection.
pub(super) const UNFILED: &str = "unfiled";

pub(super) struct Notebooks {
    pub phase: Phase<wire::NotesNotebooks>,
}

impl Notebooks {
    pub fn new() -> Self {
        Self {
            phase: Phase::Loading,
        }
    }

    pub fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(read::read(
            ctx,
            load::notes::Notebooks::default(),
            |answer| match answer {
                Answer::NotesNotebooks(notebooks) => Some(notebooks),
                _ => None,
            },
        ));
    }

    /// A notebook's name, for the heading a pick opens.
    pub fn name_of(&self, locale: Locale, id: &str) -> Option<String> {
        self.phase
            .data()?
            .notebooks
            .iter()
            .find(|notebook| notebook.notebook_id == id)
            .map(|notebook| fold::notebook_name(locale, notebook))
    }

    /// The rows: "Unfiled" first, counted by the core (`unfiled_count`, over the
    /// library's recent window — "200+ notes" when more lie beyond it).
    pub fn data(locale: Locale, answer: &wire::NotesNotebooks) -> wire::NotesNotebooksData {
        let rows: Vec<wire::NotesNotebookRow> = answer
            .notebooks
            .iter()
            .map(|notebook| {
                let title = fold::notebook_name(locale, notebook);
                let count = fold::notes_count(locale, notebook.note_count as usize, false);
                wire::NotesNotebookRow {
                    id: notebook.notebook_id.clone(),
                    accessibility_label: format!("{title}, {count}"),
                    title,
                    count,
                    manageable: true,
                }
            })
            .collect();
        let unfiled = fold::notes_count(
            locale,
            answer.unfiled_count as usize,
            answer.unfiled_truncated,
        );
        let title = words::unfiled_row(locale);
        let unfiled_row = wire::NotesNotebookRow {
            id: UNFILED.to_owned(),
            accessibility_label: format!("{title}, {unfiled}"),
            title,
            count: unfiled,
            manageable: false,
        };
        let empty = rows.is_empty().then(|| wire::EmptyState {
            headline: words::notebooks_empty_headline(locale),
            body: words::notebooks_empty_body(locale),
            action_label: words::new_notebook(locale),
            ..wire::EmptyState::default()
        });
        wire::NotesNotebooksData {
            rows: std::iter::once(unfiled_row).chain(rows).collect(),
            empty,
        }
    }
}

/// The create / rename sheet, while open.
pub(super) struct Form {
    /// Empty creates.
    pub notebook_id: String,
    pub name: String,
    /// A refusal's sentence, over the typed name.
    pub status: String,
}

impl Form {
    pub fn view(&self, locale: Locale) -> wire::NotesNotebookForm {
        let renaming = !self.notebook_id.is_empty();
        wire::NotesNotebookForm {
            notebook_id: self.notebook_id.clone(),
            title: if renaming {
                words::rename_notebook(locale)
            } else {
                words::new_notebook(locale)
            },
            name: self.name.clone(),
            placeholder: words::notebook_name(locale),
            confirm_label: if renaming {
                words::rename(locale)
            } else {
                words::create(locale)
            },
            cancel_label: words::cancel(locale),
            can_confirm: !self.name.trim().is_empty(),
            status: self.status.clone(),
        }
    }
}
