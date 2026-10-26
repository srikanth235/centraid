//! THE CORE'S DOCS ANSWERS, AS THE SCREENS DRAW THEM: every word, icon key and
//! accessibility label a row, a fact and a version carries. Pure: dates are the
//! core's `*_local` readings against the answer's own `today`, and no size, kind
//! or media type is classified here (the core answers `size`, `kind_name` and
//! `surface`).
//!
//! What depends on the SCREEN's state (the band, the pills, which empty state)
//! is the screen's; what depends only on the answer is here.

use centraid_api_proto::core_v1 as wire;

use super::{folders, routes};
use crate::kit::civil;
use crate::strings::{Locale, docs as words, shared};

/// The `design/native-catalog.json` key of a trash glyph.
pub const TRASH_ICON: &str = "trash";

// The keys a `DocsAction` carries, and so what `ActionPicked` sends.
pub const KEY_EDIT: &str = "edit";
pub const KEY_STAR: &str = "star";
pub const KEY_UNSTAR: &str = "unstar";
pub const KEY_RENAME: &str = "rename";
pub const KEY_MOVE: &str = "move";
pub const KEY_LABELS: &str = "labels";
pub const KEY_TRASH: &str = "trash";
pub const KEY_RESTORE: &str = "restore";
pub const KEY_PURGE: &str = "purge";
pub const KEY_MORE: &str = "more";

/// "1 document" / "24 documents".
#[must_use]
pub fn count_label(locale: Locale, n: u32) -> String {
    words::document_count(locale, u64::from(n))
}

/// "Changed today" / "Changed Wed 11 March", from a `YYYY-MM-DD…` reading.
#[must_use]
pub fn dated(locale: Locale, verb: &str, local: &str, today: &str) -> String {
    let Some(day) = local.get(..10) else {
        return String::new();
    };
    let said = civil::relative_day(locale, day, today);
    // "Today" and "Yesterday" are words inside the clause, not its start.
    let inline = if day == today || civil::plus_days(today, -1).as_deref() == Some(day) {
        said.to_lowercase()
    } else {
        said
    };
    format!("{verb} {inline}")
}

/// "Wed 11 March 09:12", or `None` for no reading.
#[must_use]
pub fn stamp(locale: Locale, local: &str) -> Option<String> {
    let day = local.get(..10)?;
    let clock = civil::clock(local);
    let day = civil::day_month(locale, day);
    Some(if clock.is_empty() {
        day
    } else {
        format!("{day} {clock}")
    })
}

/// One row, as every list and the document's head draw it. `parent` is the
/// title of the page that draws it: the document's back word.
#[must_use]
pub fn row(
    locale: Locale,
    row: &wire::DocsDocumentRow,
    today: &str,
    parent: &str,
) -> wire::DocsRowView {
    let title = if row.title.trim().is_empty() {
        words::untitled(locale)
    } else {
        row.title.clone()
    };
    let when = if row.trashed {
        dated(locale, &words::deleted(locale), &row.trashed_local, today)
    } else {
        let at = if row.updated_local.is_empty() {
            &row.created_local
        } else {
            &row.updated_local
        };
        dated(locale, &words::changed(locale), at, today)
    };
    let meta = [row.kind_name.clone(), row.size.clone(), when]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let accessibility_label = [
        Some(title.clone()),
        Some(meta.replace(" · ", ", ")).filter(|meta| !meta.is_empty()),
        row.starred.then(|| words::starred(locale)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ");
    wire::DocsRowView {
        document_id: row.document_id.clone(),
        content_id: row.content_id.clone(),
        route: Some(routes::document(&row.document_id, &title, parent)),
        title,
        kind_icon_key: icon_of(row.kind()).to_owned(),
        kind_label: row.kind_name.clone(),
        meta,
        surface: surface_of(row.surface()) as i32,
        starred: row.starred,
        trashed: row.trashed,
        folder_id: row.folder_id.clone(),
        labels: row
            .labels
            .iter()
            .map(|label| wire::DocsLabelChip {
                tag_id: label.tag_id.clone(),
                label: label.label.clone(),
            })
            .collect(),
        snippet: snippet(&row.snippet),
        accessibility_label,
    }
}

/// The index's highlight, `⟦`/`⟧` around the matched words, as runs.
#[must_use]
pub fn snippet(raw: &str) -> Vec<wire::DocsSnippetRun> {
    const OPEN: char = '⟦';
    const CLOSE: char = '⟧';
    let mut runs = Vec::new();
    let mut rest = raw;
    while !rest.is_empty() {
        let Some(open) = rest.find(OPEN) else {
            runs.push(run(rest, false));
            break;
        };
        if open > 0 {
            runs.push(run(&rest[..open], false));
        }
        let after = &rest[open + OPEN.len_utf8()..];
        let Some(close) = after.find(CLOSE) else {
            runs.push(run(after, true));
            break;
        };
        if close > 0 {
            runs.push(run(&after[..close], true));
        }
        rest = &after[close + CLOSE.len_utf8()..];
    }
    runs
}

fn run(text: &str, matched: bool) -> wire::DocsSnippetRun {
    wire::DocsSnippetRun {
        text: text.to_owned(),
        r#match: matched,
    }
}

#[must_use]
pub fn surface_of(surface: wire::DocsSurface) -> wire::DocsSurfaceKind {
    match surface {
        wire::DocsSurface::Reading => wire::DocsSurfaceKind::Reading,
        wire::DocsSurface::Stage => wire::DocsSurfaceKind::Stage,
        wire::DocsSurface::Facts | wire::DocsSurface::Unspecified => wire::DocsSurfaceKind::Facts,
    }
}

/// A `design/native-catalog.json` key for a kind.
#[must_use]
pub fn icon_of(kind: wire::DocsKind) -> &'static str {
    match kind {
        wire::DocsKind::Image => "Image",
        wire::DocsKind::Video => "Video",
        wire::DocsKind::Audio => "Music",
        wire::DocsKind::Spreadsheet => "Table",
        wire::DocsKind::Presentation => "Layers",
        wire::DocsKind::Pdf | wire::DocsKind::Document => "FileText",
        wire::DocsKind::Unspecified | wire::DocsKind::Other => "Paperclip",
    }
}

/// The reader's format off a media type.
#[must_use]
pub fn format_of(media_type: &str) -> wire::docs_reader::Format {
    if media_type.split(';').next().map(str::trim) == Some("text/markdown") {
        wire::docs_reader::Format::Markdown
    } else {
        wire::docs_reader::Format::Plain
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

#[must_use]
pub fn action(key: &str, label: String, icon: &str) -> wire::DocsAction {
    wire::DocsAction {
        key: key.to_owned(),
        label,
        icon_key: icon.to_owned(),
        destructive: false,
        enabled: true,
        detail: String::new(),
        route: None,
    }
}

/// A live document's menu: star, rename, move, labels, trash.
#[must_use]
pub fn menu(locale: Locale, starred: bool) -> Vec<wire::DocsAction> {
    vec![
        if starred {
            action(KEY_UNSTAR, words::action_unstar(locale), "Star")
        } else {
            action(KEY_STAR, words::action_star(locale), "Star")
        },
        action(KEY_RENAME, words::action_rename(locale), "FileEdit"),
        action(KEY_MOVE, words::action_move(locale), "Folder"),
        action(KEY_LABELS, words::action_labels(locale), "Tag"),
        wire::DocsAction {
            destructive: true,
            ..action(KEY_TRASH, words::action_trash(locale), TRASH_ICON)
        },
    ]
}

/// The head's actions: edit (text), star, rename, move, labels, then trash — or
/// restore and delete forever on a trashed document.
#[must_use]
pub fn head_actions(locale: Locale, row: &wire::DocsDocumentRow) -> Vec<wire::DocsAction> {
    if row.trashed {
        return vec![
            wire::DocsAction {
                // A lapsed grace window cannot be restored: the vault refuses.
                enabled: row.purge_in_days > 0,
                ..action(KEY_RESTORE, words::action_restore(locale), "restore")
            },
            // DOCS DESTROYS (D-1 of 2026-09-25): one trashed document, behind a confirm.
            wire::DocsAction {
                destructive: true,
                ..action(KEY_PURGE, shared::trash_purge(locale), TRASH_ICON)
            },
        ];
    }
    let mut actions = Vec::new();
    if row.surface() == wire::DocsSurface::Reading {
        actions.push(wire::DocsAction {
            route: Some(routes::editor(&row.document_id, &row.title)),
            ..action(KEY_EDIT, words::action_edit(locale), "Pencil")
        });
    }
    actions.extend(menu(locale, row.starred));
    actions
}

/// The labels sheet for a row, shared with the document page.
#[must_use]
pub fn labels_sheet(
    locale: Locale,
    row: &wire::DocsDocumentRow,
    drive_labels: &[String],
    draft: &str,
) -> wire::DocsLabelsSheet {
    let on: Vec<&str> = row.labels.iter().map(|chip| chip.label.as_str()).collect();
    let typed = draft.trim();
    wire::DocsLabelsSheet {
        current: row
            .labels
            .iter()
            .map(|chip| wire::DocsLabelChip {
                tag_id: chip.tag_id.clone(),
                label: chip.label.clone(),
            })
            .collect(),
        available: drive_labels
            .iter()
            .filter(|label| !on.contains(&label.as_str()))
            .cloned()
            .collect(),
        draft: draft.to_owned(),
        can_add: !typed.is_empty() && !on.contains(&typed),
        add_label: words::label_add(locale),
        placeholder: words::label_placeholder(locale),
        remove_label: words::label_remove(locale),
    }
}

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

/// The document screen's data: its surface, facts and activity, with the
/// drive's folders and labels for the move and labels sheets.
#[must_use]
pub fn document(
    locale: Locale,
    answer: &wire::DocsDocument,
    activity: Option<&wire::DocsActivity>,
    drive: Option<&wire::DocsDrive>,
) -> wire::DocsDocumentData {
    use wire::docs_document_data::Surface;
    let Some(found) = answer.document.as_ref() else {
        return wire::DocsDocumentData {
            surface: Some(Surface::Gone(wire::EmptyState {
                headline: words::gone(locale),
                ..wire::EmptyState::default()
            })),
            ..wire::DocsDocumentData::default()
        };
    };
    // The document's own page is the parent of what it opens (its crumbs and
    // versions): they name it, so its title is the back word.
    let view = row(locale, found, &answer.today, "");
    let events = activity.map(|a| a.events.as_slice()).unwrap_or_default();
    let surface = match found.surface() {
        wire::DocsSurface::Reading => Surface::Reading(reader(locale, found, answer)),
        wire::DocsSurface::Stage => Surface::Stage(stage(locale, found, answer, &view.title)),
        _ => Surface::FactsOnly(wire::DocsFactsOnly {
            sentence: words::facts_only(locale),
        }),
    };
    let nodes = drive
        .map(|drive| folders::nodes(locale, &drive.folders, &view.title))
        .unwrap_or_default();
    wire::DocsDocumentData {
        surface: Some(surface),
        facts: facts(locale, found, answer, &view),
        path: folders::path_crumbs(locale, &answer.path, &view.title),
        versions: versions_link(locale, answer, found, &view.title),
        activity: events.iter().map(|e| activity_row(locale, e)).collect(),
        activity_empty: if events.is_empty() {
            words::activity_empty(locale)
        } else {
            String::new()
        },
        actions: head_actions(locale, found),
        trashed_note: trashed_note(locale, found),
        folders: nodes,
        labels: drive.map(|d| d.labels.clone()).unwrap_or_default(),
        row: Some(view),
    }
}

fn versions_link(
    locale: Locale,
    answer: &wire::DocsDocument,
    row: &wire::DocsDocumentRow,
    title: &str,
) -> Option<wire::DocsVersionsLink> {
    (answer.versions.len() > 1).then(|| wire::DocsVersionsLink {
        label: words::versions_heading(locale),
        count_label: words::version_count(locale, answer.versions.len() as u64),
        route: Some(routes::versions(&row.document_id, title)),
    })
}

fn reader(
    locale: Locale,
    row: &wire::DocsDocumentRow,
    answer: &wire::DocsDocument,
) -> wire::DocsReader {
    let body = answer.body.as_deref();
    let editable = body.is_some() && !row.trashed;
    wire::DocsReader {
        body: body.unwrap_or_default().to_owned(),
        has_text: body.is_some(),
        no_text: if body.is_none() {
            words::no_text(locale)
        } else {
            String::new()
        },
        format: format_of(&row.media_type) as i32,
        editable,
        edit_label: if editable {
            words::action_edit(locale)
        } else {
            String::new()
        },
        empty_body: if body == Some("") {
            words::empty_body(locale)
        } else {
            String::new()
        },
    }
}

fn stage(
    locale: Locale,
    row: &wire::DocsDocumentRow,
    answer: &wire::DocsDocument,
    title: &str,
) -> wire::DocsStage {
    use wire::docs_stage::Media;
    wire::DocsStage {
        content_id: row.content_id.clone(),
        media: match row.kind() {
            wire::DocsKind::Image => Media::Image,
            wire::DocsKind::Pdf => Media::Pdf,
            wire::DocsKind::Audio => Media::Audio,
            wire::DocsKind::Video => Media::Video,
            _ => Media::Unspecified,
        } as i32,
        media_type: row.media_type.clone(),
        // THE FILE THE CORE HANDS OUT (R-1047-Q4): here AND drawable inline.
        // Bytes that are here but may not be drawn (HTML, SVG) say so, and the
        // facts below are the answer.
        held: !answer.bytes_path.is_empty(),
        absent_reason: if !answer.bytes_path.is_empty() {
            String::new()
        } else if answer.bytes_held {
            words::facts_only(locale)
        } else {
            answer.bytes_absent_reason.clone()
        },
        accessibility_label: format!("{title}, {}", row.kind_name),
        bytes_path: answer.bytes_path.clone(),
        play_label: words::player_play(locale),
        pause_label: words::player_pause(locale),
        position_label: words::player_position(locale),
        position_value: words::player_position_value(locale),
    }
}

fn facts(
    locale: Locale,
    row: &wire::DocsDocumentRow,
    answer: &wire::DocsDocument,
    view: &wire::DocsRowView,
) -> Vec<wire::DocsFact> {
    let fact = |label: String, detail: String| wire::DocsFact { label, detail };
    let mut facts = vec![fact(words::fact_kind(locale), view.kind_label.clone())];
    if !row.size.is_empty() {
        facts.push(fact(words::fact_size(locale), row.size.clone()));
    }
    if !row.media_type.is_empty() {
        facts.push(fact(words::fact_media_type(locale), row.media_type.clone()));
    }
    facts.push(fact(
        words::fact_folder(locale),
        answer
            .path
            .last()
            .map(|folder| folder.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| words::move_top(locale)),
    ));
    if let Some(added) = stamp(locale, &row.created_local) {
        facts.push(fact(words::fact_added(locale), added));
    }
    if let Some(changed) = stamp(locale, &row.updated_local) {
        facts.push(fact(words::fact_changed(locale), changed));
    }
    if !row.labels.is_empty() {
        facts.push(fact(
            words::fact_labels(locale),
            row.labels
                .iter()
                .map(|label| label.label.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        ));
    }
    if !answer.versions.is_empty() {
        facts.push(fact(
            words::fact_versions(locale),
            answer.versions.len().to_string(),
        ));
    }
    facts
}

/// One version of the history page.
#[must_use]
pub fn version(locale: Locale, version: &wire::DocsVersion, trashed: bool) -> wire::DocsVersionRow {
    let meta = [
        version.current.then(|| words::current(locale)),
        Some(version.size.clone()).filter(|size| !size.is_empty()),
        stamp(locale, &version.asserted_local),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    wire::DocsVersionRow {
        // THE VERSION'S KEY is its number: two versions can hold the same bytes.
        key: version.number.to_string(),
        label: format!("{} {}", words::version(locale), version.number),
        meta,
        current: version.current,
        // An earlier version of a LIVE document can be made current again; a
        // trashed one is restored first (the vault refuses otherwise).
        restore_label: if !version.current && !trashed {
            words::action_restore(locale)
        } else {
            String::new()
        },
    }
}

fn activity_row(locale: Locale, event: &wire::DocsActivityEvent) -> wire::DocsActivityRow {
    let label = match event.activity.as_str() {
        "document.add" | "document.create_text" => words::activity_added(locale),
        "document.edit" => words::activity_edited(locale),
        "entity.retitle" => words::activity_renamed(locale),
        "document.move" => words::activity_moved(locale),
        "flag.set" => words::activity_starred(locale),
        "flag.clear" => words::activity_unstarred(locale),
        "entity.trash" => words::activity_trashed(locale),
        "entity.restore" => words::activity_restored(locale),
        "document.replace" => words::activity_replaced(locale),
        "document.restore_version" => words::activity_version_restored(locale),
        "tag.add" => words::activity_labelled(locale),
        "tag.remove" => words::activity_unlabelled(locale),
        "entity.empty_trash" => words::activity_trash_emptied(locale),
        _ => words::activity_other(locale),
    };
    wire::DocsActivityRow {
        label,
        // THE JOURNAL DOES NOT SAY WHO ACTED (#1135): the line is the day alone.
        meta: stamp(locale, &event.occurred_local).unwrap_or_default(),
    }
}

/// The grace window's end is when a restore stops being possible, never a
/// promise that the document is deleted then.
fn trashed_note(locale: Locale, row: &wire::DocsDocumentRow) -> String {
    if !row.trashed {
        return String::new();
    }
    match row.purge_local_day.get(..10) {
        Some(day) if row.purge_in_days > 0 => format!(
            "{} {}",
            words::in_trash_until(locale),
            civil::day_month(locale, day)
        ),
        _ => words::in_trash_lapsed(locale),
    }
}

/// What the editor opens on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorDraft {
    pub title: String,
    pub body: String,
    pub version_label: String,
    pub format: wire::docs_reader::Format,
}

/// The editor's draft, or the reason there is none: only a live text document
/// whose text this vault holds can be edited.
///
/// # Errors
/// The member's sentence for why the document cannot be edited.
pub fn editor(locale: Locale, answer: &wire::DocsDocument) -> Result<EditorDraft, String> {
    let Some(row) = answer.document.as_ref() else {
        return Err(words::gone(locale));
    };
    if row.trashed {
        return Err(words::trashed_not_editable(locale));
    }
    let Some(body) = answer
        .body
        .as_deref()
        .filter(|_| row.surface() == wire::DocsSurface::Reading)
    else {
        return Err(words::not_editable(locale));
    };
    let current = answer
        .versions
        .iter()
        .find(|version| version.current)
        .or_else(|| answer.versions.first());
    Ok(EditorDraft {
        title: row.title.clone(),
        body: body.to_owned(),
        version_label: current
            .map(|version| format!("{} {}", words::version(locale), version.number))
            .unwrap_or_default(),
        format: format_of(&row.media_type),
    })
}
