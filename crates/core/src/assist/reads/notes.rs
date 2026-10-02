//! Notes' two reads: the library, recent first or one notebook's, and a search.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::{App, Card, ReadError, ToolCall, ToolOutput};

use super::{Answer, Env, Query, ROWS, counted, title_or, unexpected};

fn card(row: &wire::NotesRow) -> Card {
    Card::new(
        App::Notes,
        "note",
        &row.note_id,
        title_or(row.title.as_deref(), &row.preview, "Untitled note"),
    )
    .subtitle(&row.updated_local_day)
    .meta(row.notebook_names.join(", "))
}

fn hit_card(hit: &wire::NotesSearchHit) -> Card {
    Card::new(
        App::Notes,
        "note",
        &hit.note_id,
        title_or(hit.title.as_deref(), &hit.preview, "Untitled note"),
    )
    .subtitle(&hit.updated_local_day)
    .meta(hit.notebook_names.join(", "))
}

/// `notes.list`: the newest, or one notebook's.
pub(super) fn list(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let mut notebook_id = String::new();
    let mut label = "recent".to_owned();
    if let Some(named) = call.arg("notebook") {
        let Answer::NotesNotebooks(notebooks) =
            env.ask(Query::NotesNotebooks(wire::NotesNotebooksRequest {}))?
        else {
            return Err(unexpected("notes.list"));
        };
        let wanted = named.to_lowercase();
        let found = notebooks
            .notebooks
            .iter()
            .find(|book| {
                book.name
                    .as_deref()
                    .is_some_and(|name| name.to_lowercase() == wanted)
            })
            .or_else(|| {
                notebooks.notebooks.iter().find(|book| {
                    book.name
                        .as_deref()
                        .is_some_and(|name| name.to_lowercase().contains(&wanted))
                })
            });
        let Some(book) = found else {
            return Ok(ToolOutput::of_rows(
                format!("No notebook named \"{named}\""),
                Vec::new(),
            ));
        };
        notebook_id = book.notebook_id.clone();
        label = format!("in {}", book.name.as_deref().unwrap_or(named));
    }
    let Answer::NotesLibrary(library) =
        env.ask(Query::NotesLibrary(wire::NotesLibraryRequest {
            window: ROWS,
            sort: wire::NotesSort::Updated as i32,
            pinned_only: false,
            notebook_id,
            unfiled_only: false,
            tag_concept_ids: Vec::new(),
            tz: env.tz.to_owned(),
        }))?
    else {
        return Err(unexpected("notes.list"));
    };
    let rows: Vec<Card> = library.notes.iter().take(ROWS as usize).map(card).collect();
    Ok(ToolOutput::of_rows(
        format!("{} {label}", counted(rows.len(), "note", "notes")),
        rows,
    ))
}

/// `notes.search`.
pub(super) fn search(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let term = call.arg("term").unwrap_or_default();
    let Answer::NotesSearch(answer) = env.ask(Query::NotesSearch(wire::NotesSearchRequest {
        term: term.to_owned(),
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("notes.search"));
    };
    let rows: Vec<Card> = answer
        .hits
        .iter()
        .take(ROWS as usize)
        .map(hit_card)
        .collect();
    Ok(ToolOutput::of_rows(
        format!(
            "{} matching \"{term}\"",
            counted(rows.len(), "note", "notes")
        ),
        rows,
    ))
}
