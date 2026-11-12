//! EVERYTHING THE DRIVE DRAWS that depends on its state: the band, the filter
//! menu, the head, the rows, the empty choice, the sheet. Made again on every view.

use centraid_api_proto::core_v1 as wire;
use wire::docs_drive_data::{EmptyAction, Mode};

use super::query::{
    self, ANY, MODIFIED, SECTION_LABEL, SECTION_MODIFIED, SECTION_TYPE, SORTS, TYPES,
};
use super::{BAND_ALL, BAND_FOLDERS, BAND_MORE, BAND_STARRED, Drive, Held, sheets};
use crate::docs::{denied, fold, folders};
use crate::kit::quantity::UnitsPref;
use crate::kit::read::{Note, Page};
use crate::kit::{menu, search as kit_search};
use crate::screen::Ctx;
use crate::strings::{Locale, docs as words, shared};

/// The page's title: the folder open, else the shelf's own name (Recents,
/// Browse, Starred, Recently added). A pushed page is named by it.
pub(super) fn title(drive: &Drive, locale: Locale) -> String {
    use wire::DocsDestination as Dest;
    match drive.destination {
        Dest::Folders if !drive.folder_id.is_empty() => {
            if drive.folder_name.is_empty() {
                words::band_browse(locale)
            } else {
                drive.folder_name.clone()
            }
        }
        Dest::Folders => words::band_browse(locale),
        Dest::Starred => words::band_starred(locale),
        Dest::Recent => words::more_recent(locale),
        _ => words::band_recents(locale),
    }
}

pub(super) fn state(drive: &Drive, ctx: &Ctx) -> wire::ViewState {
    use wire::docs_drive_state::Content;
    let locale = ctx.locale();
    let is_denied = matches!(drive.page, Page::Refused(_));
    // A followed folder the phone read only part of is a note over the rows (its own words, and
    // no Retry: reconnecting or the follow itself is the remedy).
    let report = ctx.follows().report(crate::follow::Store::Files);
    let page =
        drive
            .page
            .clone()
            .noted(Note::partial(&report, locale, crate::follow::Store::Files));
    let content = page
        .data()
        .map(|held| Content::Data(Box::new(data(drive, locale, ctx.units(), held))));
    // Nothing to draw is the page's empty state, with the action it sends.
    let (empty, empty_action) = if matches!(page, Page::Empty) {
        empty_of(drive, locale, drive.active_term().is_some())
    } else {
        (wire::EmptyState::default(), EmptyAction::None)
    };
    let page = page.wire(locale, |denial| denied(locale, denial), || empty);
    wire::ViewState {
        kind: Some(wire::view_state::Kind::DocsDrive(Box::new(
            wire::DocsDriveState {
                destination: drive.destination as i32,
                folder_id: drive.folder_id.clone(),
                folder_name: drive.folder_name.clone(),
                layout: if drive.grid {
                    wire::docs_drive_state::Layout::Grid
                } else {
                    wire::docs_drive_state::Layout::List
                } as i32,
                search: Some(search_field(drive, locale)),
                content,
                page: Some(page),
                empty_action: empty_action as i32,
                crumbs: crumbs(drive, locale),
                sheet: Some(if is_denied {
                    sheets::none()
                } else {
                    sheets::view(drive, locale)
                }),
                status: drive.undo.status(),
                confirm: drive.asking.as_ref().map(|_| wire::Confirm {
                    title: words::trash_confirm_title(locale),
                    body: words::trash_confirm_body(locale),
                    confirm_label: words::trash_confirm(locale),
                    destructive: true,
                }),
                // THE STOP CONFIRM (#1185): the kit's sheet, named for the folder.
                stop: drive
                    .asking_stop
                    .as_ref()
                    .and_then(|origin| drive.followed.iter().find(|f| &f.origin_id == origin))
                    .map(|folder| {
                        crate::kit::follow::stop_confirm(
                            locale,
                            &words::app_title(locale),
                            &folder.name,
                            &words::followed_kept(locale),
                        )
                    }),
                rename: drive.rename.as_ref().map(|rename| rename.view(locale)),
                band: if is_denied {
                    Vec::new()
                } else {
                    band(drive, locale)
                },
                filter_menu: filter_menu(drive, locale),
                chrome: Some(chrome(drive, locale)),
                head_meta: head_meta(drive, locale),
                ingest: Some(drive.ingest.view(locale)),
            },
        ))),
        ..wire::ViewState::default()
    }
}

fn search_field(drive: &Drive, locale: Locale) -> wire::DocsSearchField {
    let held = match &drive.page {
        Page::Ready { data: held, .. } if held.search && drive.active_term().is_some() => {
            Some(held)
        }
        _ => None,
    };
    // THE ASK ROW closes an answer that matched nothing too.
    let answered =
        held.is_some() || (matches!(drive.page, Page::Empty) && drive.active_term().is_some());
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
        ask_row: answered.then(|| kit_search::offer(locale, &drive.search.term, "docs")),
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
        tab(BAND_ALL, words::band_recents(locale), "Clock", Dest::All),
        tab(
            BAND_FOLDERS,
            words::band_browse(locale),
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

/// THE HEADER'S FILTER BUTTON (R-CHROME-3): Type, Modified and Label as nested
/// sections, then the sort and the layout. "Clear filters" is the kit's row, lit
/// while a filter is set; the sort and the layout never light the button.
///
/// In search and on Recently changed (a window, not a filter) the filters and the
/// sort do not apply, so the menu holds the View section alone and is never lit:
/// the layout is the one thing the member can still choose there. None while the
/// vault denies Docs.
fn filter_menu(drive: &Drive, locale: Locale) -> Option<wire::FilterMenu> {
    if matches!(drive.page, Page::Refused(_)) {
        return None;
    }
    let narrows = drive.active_term().is_none() && drive.filtering();
    let mut sections = Vec::new();
    if narrows {
        sections.extend(filter_sections(drive, locale));
    }
    sections.push(menu::single(
        query::SECTION_VIEW,
        words::view_title(locale),
        vec![
            menu::option(query::VIEW_LIST, words::view_list(locale), !drive.grid),
            menu::option(query::VIEW_GRID, words::view_grid(locale), drive.grid),
        ],
    ));
    let filtering = narrows && drive.query.filtering();
    let mut built = menu::menu(locale, sections, filtering);
    if !narrows {
        built.spoken = words::view_title(locale);
    }
    Some(built)
}

/// The nested filters and the sort, in the order the chip row held them.
fn filter_sections(drive: &Drive, locale: Locale) -> Vec<wire::MenuSection> {
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
    let mut types = vec![menu::option(
        ANY,
        words::type_any(locale),
        type_label.is_none(),
    )];
    types.extend(TYPES.iter().map(|(key, filter, label)| {
        menu::option(*key, label(locale), query.type_filter == *filter)
    }));
    let mut modified = vec![menu::option(
        ANY,
        words::modified_any(locale),
        modified_label.is_none(),
    )];
    modified.extend(MODIFIED.iter().map(|(key, filter, _, label)| {
        menu::option(*key, label(locale), query.modified == *filter)
    }));
    let mut sections = vec![
        menu::nested(
            menu::single(SECTION_TYPE, words::filter_type(locale), types),
            type_label.unwrap_or_else(|| words::type_any(locale)),
        ),
        menu::nested(
            menu::single(SECTION_MODIFIED, words::filter_modified(locale), modified),
            modified_label.unwrap_or_else(|| words::modified_any(locale)),
        ),
    ];
    let rail_labels = drive.rail.as_ref().map(|rail| rail.labels.as_slice());
    // No label in the drive: no Label section to open an empty menu.
    if rail_labels.is_some_and(|labels| !labels.is_empty()) || label.is_some() {
        let mut labels = vec![menu::option(ANY, words::label_any(locale), label.is_none())];
        labels.extend(
            rail_labels
                .unwrap_or_default()
                .iter()
                .map(|name| menu::option(name.clone(), name.clone(), query.label == *name)),
        );
        sections.push(menu::nested(
            menu::single(SECTION_LABEL, words::filter_label(locale), labels),
            label.unwrap_or_else(|| words::label_any(locale)),
        ));
    }
    sections.push(menu::single(
        menu::SORT,
        words::sort(locale),
        SORTS
            .iter()
            .map(|(key, _, _, name, detail)| {
                menu::option(
                    *key,
                    format!("{} · {}", name(locale), detail(locale)),
                    query.sort_key() == *key,
                )
            })
            .collect(),
    ));
    sections
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
fn data(drive: &Drive, locale: Locale, units: UnitsPref, held: &Held) -> wire::DocsDriveData {
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
            let mut view = fold::row(locale, units, row, &held.today, &page);
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
    let label_chips = if held.search {
        Vec::new()
    } else {
        label_chips(drive)
    };
    wire::DocsDriveData {
        label_chips,
        mode: if held.search {
            Mode::Search
        } else {
            Mode::Shelf
        } as i32,
        rows,
        folders: folders::nodes(locale, &children, &page),
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

/// THE PATH TO THE FOLDER OPEN, top level first: on the Browse shelf's folder pages, ready or
/// empty (an empty folder still shows the way back up), and not over a search or a failure.
fn crumbs(drive: &Drive, locale: Locale) -> Vec<wire::DocsCrumb> {
    use wire::DocsDestination as Dest;
    let shown = matches!(drive.page, Page::Ready { .. } | Page::Empty);
    if !shown || drive.destination != Dest::Folders || drive.active_term().is_some() {
        return Vec::new();
    }
    let all = drive
        .rail
        .as_ref()
        .map(|rail| rail.folders.as_slice())
        .unwrap_or_default();
    folders::rail_crumbs(locale, all, &drive.folder_id, &title(drive, locale))
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

/// THE LABEL CHIPS over the shelf: every label in the drive in its colour, the
/// one filtering the shelf marked. Not on Recently added (a window, no filters).
fn label_chips(drive: &Drive) -> Vec<wire::DocsLabelChip> {
    if !drive.filtering() {
        return Vec::new();
    }
    let Some(rail) = &drive.rail else {
        return Vec::new();
    };
    rail.label_entries
        .iter()
        .map(|label| wire::DocsLabelChip {
            selected: drive.query.label == label.label,
            ..fold::chip(label)
        })
        .collect()
}

fn head_meta(drive: &Drive, locale: Locale) -> String {
    use wire::DocsDestination as Dest;
    // An empty shelf still says how many it holds (none) and what it is.
    let (search, rows) = match &drive.page {
        Page::Ready { data: held, .. } => (held.search, held.rows.len()),
        Page::Empty => (drive.active_term().is_some(), 0),
        _ => return String::new(),
    };
    let rows = u32::try_from(rows).unwrap_or(u32::MAX);
    let count = match (&drive.rail, drive.destination) {
        _ if search => rows,
        (Some(rail), Dest::All) => rail.all_count,
        (Some(rail), Dest::Starred) => rail.starred_count,
        (Some(rail), Dest::Folders) if drive.folder_id.is_empty() => rail.unfiled_count,
        _ => rows,
    };
    // RECENTS says what it is: documents changed lately, and how many there are.
    if drive.destination == Dest::All && drive.folder_id.is_empty() && !search {
        return words::recents_subtitle(locale, u64::from(count));
    }
    fold::count_label(locale, count)
}
