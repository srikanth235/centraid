//! Docs' two reads: the drive, newest first, and a search.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::{App, Card, ReadError, ToolCall, ToolOutput};

use super::{Answer, Env, Query, ROWS, counted, title_or, unexpected};

fn card(document: &wire::DocsDocumentRow) -> Card {
    let meta = if document.starred { "starred" } else { "" };
    Card::new(
        App::Docs,
        "document",
        &document.document_id,
        title_or(Some(&document.title), "", "Untitled document"),
    )
    .subtitle(
        format!("{} · {}", document.kind_name, document.updated_local).trim_matches([' ', '·']),
    )
    .meta(meta)
}

/// `docs.list`.
pub(super) fn list(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let (shelf, label) = match call.arg("shelf").unwrap_or("recent") {
        "starred" => (wire::DocsShelf::Starred, "starred"),
        "all" => (wire::DocsShelf::All, "in the drive"),
        _ => (wire::DocsShelf::Recent, "recent"),
    };
    let filter = match call.arg("type") {
        Some("pdf") => wire::DocsTypeFilter::Pdf,
        Some("image") => wire::DocsTypeFilter::Image,
        Some("word") => wire::DocsTypeFilter::Word,
        Some("spreadsheet") => wire::DocsTypeFilter::Spreadsheet,
        Some("markdown") => wire::DocsTypeFilter::Markdown,
        Some("text") => wire::DocsTypeFilter::Text,
        Some("audio") => wire::DocsTypeFilter::Audio,
        Some("video") => wire::DocsTypeFilter::Video,
        _ => wire::DocsTypeFilter::Unspecified,
    };
    let Answer::DocsDrive(drive) = env.ask(Query::DocsDrive(wire::DocsDriveRequest {
        shelf: shelf as i32,
        folder_id: String::new(),
        r#type: filter as i32,
        modified: wire::DocsModifiedFilter::Unspecified as i32,
        label: String::new(),
        sort: wire::DocsSort::Changed as i32,
        ascending: false,
        limit: ROWS,
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("docs.list"));
    };
    let rows: Vec<Card> = drive
        .documents
        .iter()
        .take(ROWS as usize)
        .map(card)
        .collect();
    Ok(ToolOutput::of_rows(
        format!("{} {label}", counted(rows.len(), "document", "documents")),
        rows,
    ))
}

/// `docs.search`.
pub(super) fn search(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let term = call.arg("term").unwrap_or_default();
    let Answer::DocsSearch(answer) = env.ask(Query::DocsSearch(wire::DocsSearchRequest {
        term: term.to_owned(),
        limit: ROWS,
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("docs.search"));
    };
    let rows: Vec<Card> = answer.documents.iter().map(card).collect();
    Ok(ToolOutput::of_rows(
        format!(
            "{} matching \"{term}\"",
            counted(rows.len(), "document", "documents")
        ),
        rows,
    ))
}
