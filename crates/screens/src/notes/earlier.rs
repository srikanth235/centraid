//! NOTES' EARLIER VERSIONS: the kit's one earlier-versions screen with Notes' spec (#1185).
//!
//! A note keeps its words, its title and the notebook it is filed in. The line a version reads as
//! is what changed in it: for the words, a short excerpt of the earlier ones (their first line,
//! cut short as the library cuts a note's preview); for the title, the earlier title; for a move,
//! the earlier notebook by name ("Unfiled" where there was none). A version that changed only
//! what the page does not show (the pin) reads "Other details".

use serde_json::Value;
use wire::app_query_response::Answer;

use super::{denied, fold};
use crate::catalog::load;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{notes as words, shared};
use centraid_api_proto::core_v1 as wire;

/// Notes' earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "notes",
    noun: shared::trash_noun_note,
    denied,
    line,
    know: Some(know),
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

/// The notebooks' names by id, for a move.
fn know(ctx: &Ctx, _note_id: &str) -> Names {
    let mut names = Names::new();
    if let Reading::Data(notebooks) =
        read::read(
            ctx,
            load::notes::Notebooks::default(),
            |answer| match answer {
                Answer::NotesNotebooks(notebooks) => Some(notebooks),
                _ => None,
            },
        )
    {
        for notebook in &notebooks.notebooks {
            names.insert(
                notebook.notebook_id.clone(),
                fold::notebook_name(ctx.locale(), notebook),
            );
        }
    }
    names
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The one line a note's fields read as: `Packing list · Pack the passport · Travel`.
fn line(look: &Look, fields: &[Field]) -> String {
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let title = named("entity.title").and_then(|field| text(&field.value));
    let body = named("note.body")
        .map(|field| fold::excerpt(field.value.as_str().unwrap_or_default()))
        .filter(|excerpt| !excerpt.is_empty());
    let notebook = named("note.notebook_id").map(|field| {
        text(&field.value).map_or_else(
            || words::unfiled_row(look.locale),
            |id| {
                look.names
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| words::untitled_notebook(look.locale))
            },
        )
    });
    [title, body, notebook]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}
