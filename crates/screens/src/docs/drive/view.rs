//! EVERYTHING THE DRIVE DRAWS that depends on its state: the band, the pills,
//! the head, the rows, the empty choice, the sheet. Made again on every view.

use centraid_api_proto::core_v1 as wire;
use wire::docs_drive_data::{EmptyAction, Mode};
use wire::docs_sheet::Kind;

use super::query::{MODIFIED, SORTS, TYPES};
use super::{BAND_ALL, BAND_FOLDERS, BAND_MORE, BAND_STARRED, Drive, Held, sheets};
use crate::docs::{Phase, denied, fold, folders};
use crate::kit::{read, search as kit_search};
use crate::screen::Ctx;
use crate::strings::{Locale, docs as words, shared};

/// The page's title: the folder open, "Recently added", else the app. A pushed
/// page is named by it.
pub(super) fn title(drive: &Drive, locale: Locale) -> String {
    use wire::DocsDestination as Dest;
    match drive.destination {
        Dest::Folders if !drive.folder_id.is_empty() => {
            if drive.folder_name.is_empty() {
                words::band_folders(locale)
            } else {
                drive.folder_name.clone()
            }
        }
        Dest::Recent => words::more_recent(locale),
        _ => words::app_title(locale),
    }
}

pub(super) fn state(drive: &Drive, ctx: &Ctx) -> wire::ViewState {
    use wire::docs_drive_state::Content;
    let locale = ctx.locale();
    let is_denied = matches!(drive.phase, Phase::Denied(_));
    let searching = drive.active_term().is_some();
    let content = match &drive.phase {
        Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
        Phase::Failed => Content::Failure(read::failure(locale)),
        Phase::Denied(denial) => Content::Denied(denied(locale, denial)),
        Phase::Ready(held) => Content::Data(Box::new(data(drive, locale, held))),
    };
    wire::ViewState {
        kind: Some(wire::view_state::Kind::DocsDrive(Box::new(
            wire::DocsDriveState {
                destination: drive.destination as i32,
                folder_id: drive.folder_id.clone(),
                folder_name: drive.folder_name.clone(),
                query: Some(drive.query.wire()),
                layout: if drive.grid {
                    wire::docs_drive_state::Layout::Grid
                } else {
                    wire::docs_drive_state::Layout::List
                } as i32,
                search: Some(search_field(drive, locale)),
                content: Some(content),
                sheet: Some(if is_denied {
                    sheets::none()
                } else {
                    sheets::view(drive, locale)
                }),
                status: drive.status.clone(),
                confirm: drive.asking.as_ref().map(|_| wire::Confirm {
                    title: words::trash_confirm_title(locale),
                    body: words::trash_confirm_body(locale),
                    confirm_label: words::trash_confirm(locale),
                    destructive: true,
                }),
                rename: drive.rename.as_ref().map(|rename| rename.view(locale)),
                band: if is_denied {
                    Vec::new()
                } else {
                    band(drive, locale)
                },
                pills: if is_denied || searching || !drive.filtering() {
                    Vec::new()
                } else {
                    pills(drive, locale)
                },
                chrome: Some(chrome(drive, locale)),
                head_meta: head_meta(drive, locale),
                ingest: Some(drive.ingest.view(locale)),
            },
        ))),
        ..wire::ViewState::default()
    }
}

fn search_field(drive: &Drive, locale: Locale) -> wire::DocsSearchField {
    let held = match &drive.phase {
        Phase::Ready(held) if held.search && drive.active_term().is_some() => Some(held),
        _ => None,
    };
    let corrected = held.map(|held| held.corrected.clone()).unwrap_or_default();
    wire::DocsSearchField {
        open: drive.search.open,
        term: drive.search.term.clone(),
        corrected_label: if corrected.is_empty() {
            String::new()
        } else {
            kit_search::corrected(locale, &corrected)
        },
        corrected,
        ask_row: held.map(|_| kit_search::offer(locale, &drive.search.term, "docs")),
    }
}

fn band(drive: &Drive, locale: Locale) -> Vec<wire::DocsBandTab> {
    use wire::DocsDestination as Dest;
    let tab = |key: &str, label: String, icon: &str, destination: Dest| wire::DocsBandTab {
        key: key.to_owned(),
        label,
        icon_key: icon.to_owned(),
        current: drive.destination == destination,
    };
    vec![
        tab(BAND_ALL, words::band_all(locale), "FileText", Dest::All),
        tab(
            BAND_FOLDERS,
            words::band_folders(locale),
            "Folder",
            Dest::Folders,
        ),
        tab(
            BAND_STARRED,
            words::band_starred(locale),
            "Star",
            Dest::Starred,
        ),
        wire::DocsBandTab {
            key: BAND_MORE.to_owned(),
            label: words::band_more(locale),
            icon_key: "MoreHoriz".to_owned(),
            current: false,
        },
    ]
}

/// THE ROOM'S CHIP ROW (R-CHROME-3): the filters first, "Clear filters" while
/// one is set, and the sort LAST, named for the order in force. Every chip but
/// Clear opens a sheet of choices, so it carries a chevron.
fn pills(drive: &Drive, locale: Locale) -> Vec<wire::DocsPill> {
    let query = &drive.query;
    let type_label = TYPES
        .iter()
        .find(|(_, filter, _)| *filter == query.type_filter)
        .map(|(_, _, label)| label(locale));
    let modified_label = MODIFIED
        .iter()
        .find(|(_, filter, _, _)| *filter == query.modified)
        .map(|(_, _, _, label)| label(locale));
    let label = Some(query.label.clone()).filter(|label| !label.is_empty());
    let sort = SORTS.iter().find(|(key, ..)| *key == query.sort_key());
    let pill = |key: Kind, name: String, chosen: Option<String>| wire::DocsPill {
        key: key as i32,
        accessibility_label: match &chosen {
            Some(chosen) => format!("{name}, {chosen}"),
            None => name.clone(),
        },
        active: chosen.is_some(),
        label: chosen.unwrap_or(name),
        chevron: true,
        clears: false,
    };
    let any_labels = drive
        .rail
        .as_ref()
        .is_some_and(|rail| !rail.labels.is_empty());
    let mut pills = vec![
        pill(Kind::Type, words::filter_type(locale), type_label.clone()),
        pill(
            Kind::Modified,
            words::filter_modified(locale),
            modified_label.clone(),
        ),
    ];
    // No label in the drive: no Label chip to open an empty sheet.
    if any_labels || label.is_some() {
        pills.push(pill(
            Kind::Label,
            words::filter_label(locale),
            label.clone(),
        ));
    }
    if type_label.is_some() || modified_label.is_some() || label.is_some() {
        pills.push(wire::DocsPill {
            key: Kind::None as i32,
            label: words::clear_filters(locale),
            accessibility_label: words::clear_filters(locale),
            clears: true,
            ..wire::DocsPill::default()
        });
    }
    let sort_name = words::sort(locale);
    pills.push(wire::DocsPill {
        key: Kind::Sort as i32,
        label: sort.map_or_else(
            || sort_name.clone(),
            |(_, _, _, name, detail)| format!("{} · {}", name(locale), detail(locale)),
        ),
        // The order is always set; it is a control, not a filter.
        active: false,
        accessibility_label: sort.map_or_else(
            || sort_name.clone(),
            |(_, _, _, name, detail)| format!("{sort_name}, {}, {}", name(locale), detail(locale)),
        ),
        chevron: true,
        clears: false,
    });
    pills
}

fn chrome(drive: &Drive, locale: Locale) -> wire::DocsDriveChrome {
    wire::DocsDriveChrome {
        title: title(drive, locale),
        home: words::band_home(locale),
        search_label: words::search_label(locale),
        search_placeholder: words::search_placeholder(locale),
        search_close: words::search_close(locale),
        retry: words::retry(locale),
        loading: words::loading(locale),
        add: words::add(locale),
        layout_toggle: if drive.grid {
            words::layout_to_list(locale)
        } else {
            words::layout_to_grid(locale)
        },
        layout_icon_key: if drive.grid { "List" } else { "Grid" }.to_owned(),
        row_menu: words::more(locale),
        starred: words::starred(locale),
        rename_placeholder: words::rename_placeholder(locale),
        rename_done: words::done(locale),
        // A folder page names the page it was pushed from (#1047).
        back: if drive.parent.is_empty() {
            words::app_title(locale)
        } else {
            drive.parent.clone()
        },
    }
}

/// The data as drawn: the folder level, the crumbs, the empty choice, a rename's
/// title over its row.
fn data(drive: &Drive, locale: Locale, held: &Held) -> wire::DocsDriveData {
    use wire::DocsDestination as Dest;
    let page = title(drive, locale);
    let in_folders = drive.destination == Dest::Folders && !held.search;
    let all = drive
        .rail
        .as_ref()
        .map(|rail| rail.folders.as_slice())
        .unwrap_or_default();
    let children: Vec<wire::DocsFolder> = if in_folders {
        all.iter()
            .filter(|folder| folder.parent_id == drive.folder_id)
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let rows: Vec<wire::DocsRowView> = held
        .rows
        .iter()
        .map(|row| {
            let mut view = fold::row(locale, row, &held.today, &page);
            if let Some(rename) = drive
                .rename
                .as_ref()
                .filter(|r| r.document_id() == view.document_id)
            {
                view.title = rename.title().to_owned();
            }
            view
        })
        .collect();
    let containers = if held.search {
        containers(locale, held, &page)
    } else {
        Vec::new()
    };
    // A FOLDER THAT MATCHED THE NAME IS AN ANSWER: no "nothing found" over it.
    let nothing = rows.is_empty() && children.is_empty() && (!held.search || containers.is_empty());
    let (empty, action) = if nothing {
        let (empty, action) = empty_of(drive, locale, held.search);
        (Some(empty), action)
    } else {
        (None, EmptyAction::None)
    };
    wire::DocsDriveData {
        mode: if held.search {
            Mode::Search
        } else {
            Mode::Shelf
        } as i32,
        rows,
        folders: folders::nodes(locale, &children, &page),
        crumbs: if in_folders {
            folders::rail_crumbs(locale, all, &drive.folder_id, &page)
        } else {
            Vec::new()
        },
        empty,
        empty_action: action as i32,
        // Search is not windowed; only a shelf can be cut short.
        truncated_note: if !held.search && held.truncated {
            words::truncated(locale)
        } else {
            String::new()
        },
        shelf_note: if drive.destination == Dest::Recent && !held.search {
            words::recent_rule(locale)
        } else {
            String::new()
        },
        containers,
    }
}

/// THE FOLDERS A TERM NAMED, as the kit's containers. Folders only: a hit of
/// another kind is a plain row elsewhere and never a container here.
fn containers(locale: Locale, held: &Held, page: &str) -> Vec<wire::SearchContainer> {
    held.containers
        .iter()
        .filter(|hit| hit.entity == "folder")
        .map(|hit| {
            let kind_label = shared::search_kind_folder(locale);
            wire::SearchContainer {
                entity: hit.entity.clone(),
                id: hit.id.clone(),
                app_id: hit.app_id.clone(),
                accessibility_label: format!("{kind_label}, {}", hit.title),
                kind_label,
                title: hit.title.clone(),
                icon_key: "Folder".to_owned(),
                route: Some(crate::docs::routes::folder(&hit.id, &hit.title, page)),
            }
        })
        .collect()
}

fn empty_of(drive: &Drive, locale: Locale, search: bool) -> (wire::EmptyState, EmptyAction) {
    use wire::DocsDestination as Dest;
    let say = |headline: String, body: String, action: String| wire::EmptyState {
        headline,
        body,
        action_label: action,
        ..wire::EmptyState::default()
    };
    let none = String::new();
    if search {
        return (
            say(
                words::empty_search(locale),
                words::empty_search_body(locale),
                none,
            ),
            EmptyAction::None,
        );
    }
    if drive.query.filtering() && drive.filtering() {
        return (
            say(
                words::empty_filtered(locale),
                none,
                words::clear_filters(locale),
            ),
            EmptyAction::ClearFilters,
        );
    }
    match drive.destination {
        Dest::Starred => (
            say(
                words::empty_starred(locale),
                words::empty_starred_body(locale),
                none,
            ),
            EmptyAction::None,
        ),
        Dest::Recent => (
            say(
                words::empty_recent(locale),
                none,
                words::empty_all_action(locale),
            ),
            EmptyAction::Add,
        ),
        Dest::Folders if drive.folder_id.is_empty() => (
            say(
                words::empty_folders(locale),
                none,
                words::empty_folders_action(locale),
            ),
            EmptyAction::NewFolder,
        ),
        Dest::Folders => (
            say(
                words::empty_folder(locale),
                none,
                words::empty_all_action(locale),
            ),
            EmptyAction::Add,
        ),
        // THE WHOLE DRIVE IS EMPTY: Docs' day one.
        _ => (
            say(
                words::empty_all(locale),
                none,
                words::empty_all_action(locale),
            ),
            EmptyAction::Add,
        ),
    }
}

fn head_meta(drive: &Drive, locale: Locale) -> String {
    use wire::DocsDestination as Dest;
    let Phase::Ready(held) = &drive.phase else {
        return String::new();
    };
    let rows = u32::try_from(held.rows.len()).unwrap_or(u32::MAX);
    let count = match (&drive.rail, drive.destination) {
        _ if held.search => rows,
        (Some(rail), Dest::All) => rail.all_count,
        (Some(rail), Dest::Starred) => rail.starred_count,
        (Some(rail), Dest::Folders) if drive.folder_id.is_empty() => rail.unfiled_count,
        _ => rows,
    };
    fold::count_label(locale, count)
}
