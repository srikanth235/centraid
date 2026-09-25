//! DOCS' ARM OF THE APP QUERY (#1046): `crates/apps/docs`' folds, asked
//! through [`super::VaultDoor`] and spelled as `docs.proto` spells them.
//!
//! The shelves, the filters, the order, the kinds and every civil date are the
//! crate's (`centraid_apps_docs::{phone, kind}`); this module resolves the zone
//! and the vault clock, runs the loader, and converts. Two facts only the core
//! can add, and adds here:
//!
//! - **the size phrase**, through `centraid_vault::page::format_byte_size` —
//!   the formatter Home's Docs tile already reads, so a launcher row and a
//!   drive row cannot disagree about one file;
//! - **whether the head's bytes are on this device**, through
//!   [`Vault::content_location`], which asks the byte store — a question no
//!   page read can answer.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::local;
use centraid_apps_docs as docs;
use centraid_apps_docs::kind::{self, Kind, Surface, TypeFilter};
use centraid_apps_docs::phone::{self, Modified, Shelf, Sort, View};
use centraid_apps_docs::queries::{
    DOCUMENT_TARGET_TYPE, DocumentRow, DriveInput, FolderRow, VersionRow,
};
use centraid_vault::Vault;
use centraid_vault::page::format_byte_size;
use centraid_vault::time::zone::FireZone;

use super::{RecordingSearch, VaultDoor, settle, zone_of};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The vault clock, read once per query: its instant, and in `zone` its day
/// and wall clock.
struct Clock {
    now_ms: i64,
    today: String,
    now_local: String,
}

fn clock(zone: &FireZone, now: &str) -> Result<Clock> {
    let invariant = |what: &str| CoreError::Invariant {
        context: format!("the vault clock's {what} did not read: {now}"),
    };
    Ok(Clock {
        now_ms: centraid_vault::time::recurrence::parse_instant_ms(now)
            .ok_or_else(|| invariant("instant"))?,
        today: local::today(zone, now).ok_or_else(|| invariant("day"))?,
        now_local: local::now_local(zone, now).ok_or_else(|| invariant("wall clock"))?,
    })
}

fn view_of(asked: &wire::DocsDriveRequest) -> View {
    use wire::{DocsModifiedFilter as M, DocsShelf as S, DocsSort as O, DocsTypeFilter as T};
    let non_empty = |value: &str| (!value.is_empty()).then(|| value.to_owned());
    View {
        shelf: match asked.shelf() {
            S::Unspecified | S::All => Shelf::All,
            S::Folder => Shelf::Folder(non_empty(&asked.folder_id)),
            S::Starred => Shelf::Starred,
            S::Recent => Shelf::Recent,
            S::Trash => Shelf::Trash,
        },
        type_filter: match asked.r#type() {
            T::Unspecified => None,
            T::Pdf => Some(TypeFilter::Pdf),
            T::Image => Some(TypeFilter::Image),
            T::Word => Some(TypeFilter::Word),
            T::Spreadsheet => Some(TypeFilter::Spreadsheet),
            T::Markdown => Some(TypeFilter::Markdown),
            T::Text => Some(TypeFilter::Text),
            T::Audio => Some(TypeFilter::Audio),
            T::Video => Some(TypeFilter::Video),
        },
        modified: match asked.modified() {
            M::Unspecified => None,
            M::Today => Some(Modified::Today),
            M::Last7Days => Some(Modified::Last7Days),
            M::Last30Days => Some(Modified::Last30Days),
            M::ThisYear => Some(Modified::ThisYear),
        },
        label: non_empty(&asked.label),
        sort: match asked.sort() {
            O::Unspecified | O::Changed => Sort::Changed,
            O::Name => Sort::Name,
            O::Kind => Sort::Kind,
            O::Size => Sort::Size,
        },
        ascending: asked.ascending,
    }
}

/// `docs.drive`: one shelf, cut from the one window.
pub(super) fn drive(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::DocsDriveRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let clock = clock(&zone, now)?;
    let view = view_of(asked);
    let input = DriveInput {
        limit: Some(usize::try_from(asked.limit).unwrap_or(usize::MAX)),
    };
    settle(door, docs::load_drive(door, input), |data| {
        let shelf = phone::shelve(&data, &view, &zone, &clock.today, clock.now_ms);
        Answer::DocsDrive(wire::DocsDrive {
            documents: shelf
                .documents
                .into_iter()
                .map(|row| row_to_wire(row, &zone, &clock.today))
                .collect(),
            folders: data
                .folders
                .into_iter()
                .map(|folder| {
                    let count = shelf
                        .folder_counts
                        .get(&folder.folder_id)
                        .copied()
                        .unwrap_or_default();
                    folder_to_wire(folder, count)
                })
                .collect(),
            labels: shelf.labels,
            all_count: count_of(shelf.all_count),
            unfiled_count: count_of(shelf.unfiled_count),
            starred_count: count_of(shelf.starred_count),
            trash_count: count_of(shelf.trash_count),
            truncated: data.truncated,
            window: count_of(data.window),
            today: clock.today,
            now_local: clock.now_local,
        })
    })
}

/// `docs.search`: the FTS door's hits over the same read connection the page
/// door uses, folded by the app — [`super::search_events`]'s construction.
pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::DocsSearchRequest,
) -> Result<Answer> {
    if asked.limit == 0 {
        return Err(CoreError::InvalidRequest {
            detail: "a docs search carries no limit; a default is how an unbounded read gets \
                     written by accident"
                .to_owned(),
        });
    }
    let zone = zone_of(vault, &asked.tz)?;
    let clock = clock(&zone, now)?;
    let loaded = vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection) {
            Ok(index) => index,
            Err(error) => {
                return Ok(Err(CoreError::Invariant {
                    context: format!("the search index will not open: {error}"),
                }));
            }
        };
        let search = RecordingSearch {
            inner: &index,
            door,
        };
        Ok(Ok(docs::load_search_term(
            door,
            &search,
            &centraid_search::Principal::Owner,
            &asked.term,
            usize::try_from(asked.limit).unwrap_or(usize::MAX),
        )))
    })??;
    settle(door, loaded, |data| {
        Answer::DocsSearch(wire::DocsSearch {
            documents: data
                .documents
                .into_iter()
                .map(|row| row_to_wire(row, &zone, &clock.today))
                .collect(),
            today: clock.today,
        })
    })
}

/// `docs.document`: the row, its folder path, its version chain, its text and
/// whether its bytes are here.
pub(super) fn document(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::DocsDocumentRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let clock = clock(&zone, now)?;
    let loaded = docs::load_document(door, &asked.document_id);
    // The history is a second loader over the same door; a denial or failure
    // in either answers for the whole screen.
    let loaded = loaded.and_then(|(data, denial)| {
        if denial.is_some() || data.row.is_none() {
            return Ok(((data, docs::HistoryData::default()), denial));
        }
        let (history, denial) = docs::load_history(door, &asked.document_id)?;
        Ok(((data, history), denial))
    });
    // WHERE THE BYTES ARE, asked of the byte store. Only for a document that
    // exists; a vault failure here is an error, as any other read's is.
    let held = match &loaded {
        Ok(((data, _), None)) => match &data.row {
            Some(row) => Some(vault.content_location(
                &row.content_id,
                DOCUMENT_TARGET_TYPE,
                &row.document_id,
            )?),
            None => None,
        },
        _ => None,
    };
    settle(door, loaded, |(data, history)| {
        let count = history.versions.len();
        Answer::DocsDocument(wire::DocsDocument {
            document: data.row.map(|row| row_to_wire(row, &zone, &clock.today)),
            path: data
                .path
                .into_iter()
                .map(|folder| folder_to_wire(folder, 0))
                .collect(),
            versions: history
                .versions
                .into_iter()
                .enumerate()
                .map(|(index, version)| version_to_wire(version, count - index, &zone))
                .collect(),
            body: data.body,
            bytes_held: held
                .as_ref()
                .is_some_and(|location| location.path.is_some()),
            bytes_absent_reason: held
                .map(|location| location.absent_reason)
                .unwrap_or_default(),
            today: clock.today,
            now_local: clock.now_local,
        })
    })
}

/// `docs.activity`: the audit trail, newest first.
pub(super) fn activity(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::DocsActivityRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    settle(
        door,
        docs::load_activity(door, &asked.document_id),
        |data| {
            Answer::DocsActivity(wire::DocsActivity {
                events: data
                    .events
                    .into_iter()
                    .map(|event| {
                        let occurred_at = event.occurred_at.unwrap_or_default();
                        wire::DocsActivityEvent {
                            activity: event.activity.unwrap_or_default(),
                            agent_kind: event.agent_kind.unwrap_or_default(),
                            occurred_local: phone::local_minute(&zone, &occurred_at),
                            occurred_at,
                        }
                    })
                    .collect(),
            })
        },
    )
}

// ---------------------------------------------------------------------------
// The conversion. ONE place, so a field that moved is one edit.
// ---------------------------------------------------------------------------

fn count_of(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn size_of(bytes: Option<i64>) -> String {
    bytes.map(format_byte_size).unwrap_or_default()
}

fn folder_to_wire(folder: FolderRow, count: usize) -> wire::DocsFolder {
    wire::DocsFolder {
        folder_id: folder.folder_id,
        name: folder.name.unwrap_or_default(),
        parent_id: folder.parent_id.unwrap_or_default(),
        document_count: count_of(count),
    }
}

fn kind_to_wire(kind: Kind) -> wire::DocsKind {
    match kind {
        Kind::Pdf => wire::DocsKind::Pdf,
        Kind::Image => wire::DocsKind::Image,
        Kind::Video => wire::DocsKind::Video,
        Kind::Audio => wire::DocsKind::Audio,
        Kind::Spreadsheet => wire::DocsKind::Spreadsheet,
        Kind::Presentation => wire::DocsKind::Presentation,
        Kind::Document => wire::DocsKind::Document,
        Kind::Other => wire::DocsKind::Other,
    }
}

fn surface_to_wire(surface: Surface) -> wire::DocsSurface {
    match surface {
        Surface::Reading => wire::DocsSurface::Reading,
        Surface::Stage => wire::DocsSurface::Stage,
        Surface::Facts => wire::DocsSurface::Facts,
    }
}

fn row_to_wire(row: DocumentRow, zone: &FireZone, today: &str) -> wire::DocsDocumentRow {
    let kind = kind::kind_of(row.media_type.as_deref(), row.title.as_deref());
    let surface = kind::surface_of(row.media_type.as_deref(), row.title.as_deref());
    let created_at = row.created_at.unwrap_or_default();
    let updated_at = row.updated_at.unwrap_or_default();
    // Trash only: a live row states no trash dates, whatever a stale column
    // might hold.
    let (trashed_at, purge_at) = if row.trashed {
        (
            row.deleted_at.unwrap_or_default(),
            row.purge_at.unwrap_or_default(),
        )
    } else {
        (String::new(), String::new())
    };
    let purge_local_day = phone::local_day(zone, &purge_at);
    wire::DocsDocumentRow {
        kind: kind_to_wire(kind) as i32,
        kind_name: kind.name().to_owned(),
        surface: surface_to_wire(surface) as i32,
        size: size_of(row.byte_size),
        created_local: phone::local_minute(zone, &created_at),
        updated_local: phone::local_minute(zone, &updated_at),
        trashed_local: phone::local_minute(zone, &trashed_at),
        purge_in_days: phone::days_between(today, &purge_local_day)
            .and_then(|days| i32::try_from(days).ok())
            .unwrap_or_default(),
        purge_local_day,
        document_id: row.document_id,
        content_id: row.content_id,
        title: row.title.unwrap_or_default(),
        media_type: row.media_type.unwrap_or_default(),
        folder_id: row.folder_id.unwrap_or_default(),
        starred: row.starred,
        trashed: row.trashed,
        labels: row
            .tags
            .into_iter()
            .map(|tag| wire::DocsLabel {
                tag_id: tag.tag_id,
                label: tag.label,
            })
            .collect(),
        created_at,
        updated_at,
        trashed_at,
        purge_at,
        snippet: row.snippet.unwrap_or_default(),
    }
}

fn version_to_wire(version: VersionRow, number: usize, zone: &FireZone) -> wire::DocsVersion {
    let asserted_at = version.asserted_at.unwrap_or_default();
    wire::DocsVersion {
        size: size_of(version.byte_size),
        number: count_of(number),
        asserted_local: phone::local_minute(zone, &asserted_at),
        asserted_at,
        content_id: version.content_id,
        media_type: version.media_type.unwrap_or_default(),
        current: version.current,
    }
}

#[cfg(test)]
#[path = "docs_tests.rs"]
mod tests;
