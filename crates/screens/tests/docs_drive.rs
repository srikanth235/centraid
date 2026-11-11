//! Docs' drive (`docs.drive`): ports of the `DocsSpec` drive cases — the shelves,
//! the band, the filter menu, search, the row menu, move, labels, rename, a folder
//! page and the Add sheet — through `Driver`, the door a shell uses.

mod docs_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::docs::{self, routes};
use centraid_screens::kit::menu;
use centraid_screens::testing::Driver;
use docs_support::*;
use wire::docs_drive_event as de;
use wire::docs_drive_event::Kind as D;
use wire::docs_sheet::Kind as Sheet;

fn state(d: &Driver, i: u64) -> &wire::DocsDriveState {
    drive_state(d.view(i))
}

#[test]
fn the_drive_opens_on_all_with_the_band_and_the_count() {
    let d = driver();
    let i = root(&d);
    let drive = state(&d, i);
    assert_eq!(drive.destination, wire::DocsDestination::All as i32);
    assert_eq!(drive.chrome.as_ref().unwrap().title, "Recents");
    assert_eq!(drive.chrome.as_ref().unwrap().back, "Docs");
    let band: Vec<(&str, bool)> = drive
        .band
        .iter()
        .map(|tab| (tab.key.as_str(), tab.current))
        .collect();
    assert_eq!(
        band,
        [
            ("all", true),
            ("folders", false),
            ("starred", false),
            ("more", false)
        ]
    );
    // The seeded vault holds four documents.
    assert!(
        drive.head_meta.ends_with("documents in Docs"),
        "{}",
        drive.head_meta
    );
    assert!(titles(d.view(i)).contains(&"Tahoe packing list".to_owned()));
}

#[test]
fn the_band_moves_in_place_and_the_tab_you_are_on_is_nothing() {
    let mut d = driver();
    let i = root(&d);
    band(&mut d, i, "starred");
    let drive = state(&d, i);
    assert_eq!(drive.destination, wire::DocsDestination::Starred as i32);
    assert_eq!(titles(d.view(i)), ["Tahoe packing list"]);
    assert!(
        drive.head_meta.starts_with("1 document"),
        "{}",
        drive.head_meta
    );
    // The same tab again changes nothing and reads nothing new.
    band(&mut d, i, "starred");
    assert_eq!(titles(d.view(i)), ["Tahoe packing list"]);
    band(&mut d, i, "more");
    assert_eq!(
        sheet_keys(state(&d, i)),
        ["recent", "export", "trash_shelf"],
        "More lists Recently added, Export and Trash; Followed only once a folder is followed"
    );
}

#[test]
fn a_row_says_kind_size_and_when_in_words() {
    let d = driver();
    let i = root(&d);
    let row = row(d.view(i), "Tahoe packing list");
    assert!(row.starred);
    assert_eq!(row.kind_icon_key, "FileText");
    assert!(row.meta.contains("Changed today"), "{}", row.meta);
    assert!(row.accessibility_label.starts_with("Tahoe packing list, "));
    assert!(row.accessibility_label.ends_with("Starred"));
    // A tap opens the document, with this page's title as its back word.
    let route = row.route.as_ref().unwrap();
    assert_eq!(route.screen, docs::DOCUMENT);
    let Some(wire::route::Args::DocsDocument(args)) = &route.args else {
        panic!("not a document route");
    };
    assert_eq!(args.document_id, row.document_id);
    assert_eq!(args.parent, "Recents");
}

/// The menu the drive draws.
fn filter_menu(d: &Driver, i: u64) -> &wire::FilterMenu {
    state(d, i)
        .filter_menu
        .as_ref()
        .expect("the drive has a filter menu")
}

fn section<'a>(d: &'a Driver, i: u64, key: &str) -> &'a wire::MenuSection {
    menu::find(filter_menu(d, i), key).unwrap_or_else(|| panic!("no {key} section"))
}

#[test]
fn the_filter_menu_holds_three_nested_filters_the_sort_and_the_view() {
    let d = driver();
    let i = root(&d);
    let built = filter_menu(&d, i);
    let keys: Vec<_> = built.sections.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["type", "modified", "label", "sort", "view"]);
    let nested: Vec<_> = built.sections.iter().map(|s| s.nested).collect();
    assert_eq!(nested, [true, true, true, false, false]);
    assert!(
        built
            .sections
            .iter()
            .all(|s| s.kind == wire::menu_section::Kind::Single as i32)
    );
    assert!(!built.filtering);
    assert_eq!(built.spoken, "Filter and sort");
    assert_eq!(built.clear_label, "Clear filters");
    // "Any" is first and checked; a nested section says its value in a word.
    let types = section(&d, i, "type");
    assert_eq!(types.title, "Type");
    assert_eq!(types.summary, "Any type");
    assert_eq!(types.options[0].key, "any");
    assert_eq!(menu::checked(types), ["any"]);
    assert_eq!(types.options.len(), 9);
    assert_eq!(section(&d, i, "modified").summary, "Any time");
    assert_eq!(section(&d, i, "modified").options.len(), 5);
    // The drive's labels are the Label section's options.
    let labels = section(&d, i, "label");
    assert_eq!(labels.summary, "Any label");
    assert!(labels.options.iter().any(|o| o.key == "tahoe"));
    // Six orders, each named for the order it is: "Name · A to Z".
    let sort = section(&d, i, "sort");
    assert_eq!(sort.options.len(), 6);
    assert_eq!(menu::checked(sort), ["changed_desc"]);
    assert_eq!(sort.options[0].label, "Date changed · Newest first");
    assert_eq!(sort.options[2].label, "Name · A to Z");
    // The layout is a choice of the menu: a grid (real thumbnails) until a list is picked.
    let view = section(&d, i, "view");
    assert_eq!(view.title, "View");
    assert_eq!(menu::checked(view), ["grid"]);
}

#[test]
fn filters_are_the_requests_and_the_menu_follows_them() {
    let mut d = driver();
    let i = root(&d);
    let all = titles(d.view(i)).len();
    pdf(&d, "Lease.pdf", 'a');
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    menu_pick(&mut d, i, "type", "pdf");
    assert_eq!(titles(d.view(i)), ["Lease.pdf"]);
    let built = filter_menu(&d, i);
    assert!(built.filtering);
    assert_eq!(built.spoken, "Filter and sort, on");
    let types = section(&d, i, "type");
    assert_eq!(menu::checked(types), ["pdf"]);
    assert_eq!(types.summary, "PDFs");
    // The other filters are untouched.
    assert_eq!(menu::checked(section(&d, i, "modified")), ["any"]);
    // Modified and Label are their own requests too.
    menu_pick(&mut d, i, "modified", "today");
    assert_eq!(section(&d, i, "modified").summary, "Today");
    menu_pick(&mut d, i, "modified", "any");
    menu_pick(&mut d, i, "type", "any");
    menu_pick(&mut d, i, "label", "tahoe");
    assert_eq!(titles(d.view(i)), ["Tahoe packing list"]);
    assert_eq!(section(&d, i, "label").summary, "tahoe");
    assert!(filter_menu(&d, i).filtering);
    menu_pick(&mut d, i, "type", "pdf");
    assert!(
        titles(d.view(i)).is_empty(),
        "a label and a type narrow together"
    );
    // Clear filters reads the shelf back and keeps the order.
    menu_pick(&mut d, i, "sort", "name_asc");
    menu_clear(&mut d, i);
    assert_eq!(titles(d.view(i)).len(), all + 1);
    let built = filter_menu(&d, i);
    assert!(!built.filtering);
    for key in ["type", "modified", "label"] {
        assert_eq!(menu::checked(menu::find(built, key).unwrap()), ["any"]);
    }
    assert_eq!(menu::checked(section(&d, i, "sort")), ["name_asc"]);
    // A filter nothing matches is its own empty state with the one action.
    menu_pick(&mut d, i, "type", "video");
    let empty = drive_empty(d.view(i));
    assert_eq!(empty.headline, "Nothing matches these filters.");
    assert_eq!(empty.action_label, "Clear filters");
    assert_eq!(
        state(&d, i).empty_action,
        wire::docs_drive_data::EmptyAction::ClearFilters as i32
    );
    // That action is the menu's Clear.
    menu_clear(&mut d, i);
    assert_eq!(titles(d.view(i)).len(), all + 1);
}

#[test]
fn a_pick_the_menu_does_not_hold_is_nothing() {
    let mut d = driver();
    let i = root(&d);
    let before = titles(d.view(i));
    menu_pick(&mut d, i, "type", "pdf");
    let filtered = titles(d.view(i));
    menu_pick(&mut d, i, "sort", "sideways");
    menu_pick(&mut d, i, "colour", "red");
    assert_eq!(titles(d.view(i)), filtered);
    assert_eq!(menu::checked(section(&d, i, "sort")), ["changed_desc"]);
    menu_clear(&mut d, i);
    assert_eq!(titles(d.view(i)), before);
}

#[test]
fn the_sort_is_a_choice_of_the_menu_and_never_lights_it() {
    let mut d = driver();
    let i = root(&d);
    menu_pick(&mut d, i, "sort", "name_asc");
    let titles_now = titles(d.view(i));
    let mut sorted = titles_now.clone();
    sorted.sort_by_key(|title| title.to_lowercase());
    assert_eq!(titles_now, sorted);
    assert_eq!(menu::checked(section(&d, i, "sort")), ["name_asc"]);
    assert!(!filter_menu(&d, i).filtering, "an order is not a filter");
    menu_pick(&mut d, i, "sort", "name_desc");
    assert_eq!(menu::checked(section(&d, i, "sort")), ["name_desc"]);
    let titles_now = titles(d.view(i));
    let mut sorted = titles_now.clone();
    sorted.sort_by_key(|title| std::cmp::Reverse(title.to_lowercase()));
    assert_eq!(titles_now, sorted);
}

#[test]
fn the_layout_is_the_views_section_and_changes_no_filter() {
    let mut d = driver();
    let i = root(&d);
    assert_eq!(
        state(&d, i).layout,
        wire::docs_drive_state::Layout::Grid as i32
    );
    menu_pick(&mut d, i, "view", "list");
    assert_eq!(
        state(&d, i).layout,
        wire::docs_drive_state::Layout::List as i32
    );
    assert_eq!(menu::checked(section(&d, i, "view")), ["list"]);
    assert!(!filter_menu(&d, i).filtering);
    menu_pick(&mut d, i, "view", "grid");
    assert_eq!(
        state(&d, i).layout,
        wire::docs_drive_state::Layout::Grid as i32
    );
    // Clear filters keeps the layout.
    menu_pick(&mut d, i, "view", "grid");
    menu_pick(&mut d, i, "type", "pdf");
    menu_clear(&mut d, i);
    assert_eq!(menu::checked(section(&d, i, "view")), ["grid"]);
}

#[test]
fn recently_added_is_a_window_with_no_filters_and_its_rule_said_once() {
    let mut d = driver();
    let i = root(&d);
    menu_pick(&mut d, i, "type", "pdf");
    band(&mut d, i, "more");
    pick(&mut d, i, "recent");
    let drive = state(&d, i);
    assert_eq!(drive.destination, wire::DocsDestination::Recent as i32);
    assert_eq!(drive.chrome.as_ref().unwrap().title, "Recently added");
    // The filters and the order do not apply: the menu is the layout alone, and
    // the type chosen on All does not light it.
    let built = filter_menu(&d, i);
    let keys: Vec<_> = built.sections.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["view"]);
    assert!(!built.filtering);
    assert_eq!(built.spoken, "View");
    assert_eq!(
        drive_data(d.view(i)).shelf_note,
        "Most recently added documents."
    );
    assert!(!titles(d.view(i)).is_empty(), "the filter did not apply");
    // Back on All the filter is still in force.
    band(&mut d, i, "all");
    assert!(filter_menu(&d, i).filtering);
}

#[test]
fn search_is_a_field_a_term_reads_search_and_closing_reads_the_shelf_back() {
    let mut d = driver();
    let i = root(&d);
    let shelf = titles(d.view(i));
    drive_send(&mut d, i, D::SearchOpened(de::SearchOpened {}));
    assert!(state(&d, i).search.as_ref().unwrap().open);
    search(&mut d, i, "tahoe");
    let data = drive_data(d.view(i));
    assert_eq!(data.mode, wire::docs_drive_data::Mode::Search as i32);
    assert!(
        data.rows
            .iter()
            .any(|row| row.title == "Tahoe packing list")
    );
    assert!(data.rows.iter().all(|row| !row.snippet.is_empty()));
    // The Ask row for the answered term, scoped to Docs, matched or not.
    let ask = state(&d, i)
        .search
        .as_ref()
        .unwrap()
        .ask_row
        .as_ref()
        .unwrap();
    assert_eq!(ask.label, "Ask about “tahoe”");
    assert_eq!(ask.question, "Find tahoe");
    assert_eq!(ask.scope, "docs");
    // The band stays out of search's way, and the filters and the order do not
    // apply to hits: the menu is the layout alone.
    let keys: Vec<_> = filter_menu(&d, i)
        .sections
        .iter()
        .map(|s| s.key.clone())
        .collect();
    assert_eq!(keys, ["view"]);
    assert!(!filter_menu(&d, i).filtering);
    // A term cleared to nothing reads the shelf back under the field.
    search(&mut d, i, "  ");
    assert_eq!(filter_menu(&d, i).sections.len(), 5);
    assert_eq!(
        drive_data(d.view(i)).mode,
        wire::docs_drive_data::Mode::Shelf as i32
    );
    search(&mut d, i, "tahoe");
    drive_send(&mut d, i, D::SearchClosed(de::SearchClosed {}));
    assert_eq!(titles(d.view(i)), shelf);
    assert!(state(&d, i).search.as_ref().unwrap().ask_row.is_none());
}

#[test]
fn a_search_that_finds_nothing_says_so_and_still_offers_ask() {
    let mut d = driver();
    let i = root(&d);
    search(&mut d, i, "zzzqqq");
    let empty = drive_empty(d.view(i));
    assert_eq!(empty.headline, "Nothing matches that.");
    assert_eq!(empty.body, "Try fewer words.");
    assert!(state(&d, i).search.as_ref().unwrap().ask_row.is_some());
}

#[test]
fn a_folder_found_by_name_is_a_container_with_no_nothing_found_over_it() {
    let mut d = driver();
    let i = root(&d);
    search(&mut d, i, "Travel");
    let data = drive_data(d.view(i));
    let container = data
        .containers
        .iter()
        .find(|container| container.title == "Travel")
        .expect("the folder is an answer");
    assert_eq!(container.kind_label, "Folder");
    assert_eq!(container.accessibility_label, "Folder, Travel");
    assert_eq!(container.route.as_ref().unwrap().screen, docs::DRIVE);
    // Closing search puts the container away.
    drive_send(&mut d, i, D::SearchClosed(de::SearchClosed {}));
    assert!(drive_data(d.view(i)).containers.is_empty());
}

#[test]
fn every_shelf_has_its_own_empty_sentence_and_at_most_one_action() {
    let mut d = driver();
    let i = root(&d);
    // Starred, with the only star un-starred.
    let tahoe = row(d.view(i), "Tahoe packing list").document_id.clone();
    arrange(&d, act::docs::Unstar { document_id: tahoe });
    band(&mut d, i, "starred");
    let empty = drive_empty(d.view(i));
    assert_eq!(empty.headline, "Nothing starred yet.");
    assert_eq!(empty.body, "Star a document to keep it here.");
    assert_eq!(
        state(&d, i).empty_action,
        wire::docs_drive_data::EmptyAction::None as i32
    );
}

#[test]
fn the_row_menu_stars_once_per_intent_and_a_refusal_keeps_the_rows() {
    let mut d = driver();
    let i = root(&d);
    let id = text(&d, "Notes", "words");
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    row_menu(&mut d, i, &id);
    let drive = state(&d, i);
    assert_eq!(drive.sheet.as_ref().unwrap().title, "Notes");
    assert_eq!(
        sheet_keys(drive),
        ["star", "rename", "move", "labels", "trash"]
    );
    pick(&mut d, i, "star");
    assert!(row(d.view(i), "Notes").starred);
    assert!(matches!(
        state(&d, i).sheet.as_ref().unwrap().kind(),
        Sheet::None
    ));
    row_menu(&mut d, i, &id);
    assert_eq!(sheet_keys(state(&d, i))[0], "unstar");
    pick(&mut d, i, "unstar");
    assert!(!row(d.view(i), "Notes").starred);
    // A document trashed under the page: the write is refused, the rows stay,
    // and the sentence is over them.
    row_menu(&mut d, i, &id);
    arrange(
        &d,
        act::docs::Trash {
            document_id: id.clone(),
        },
    );
    // The sheet follows the re-read: its row is gone, so is the sheet.
    d.pump(std::time::Duration::from_millis(200));
    assert!(matches!(
        state(&d, i).sheet.as_ref().unwrap().kind(),
        Sheet::None
    ));
    // Nothing was written under it: the line is still the unstar's, with Undo (#1185).
    let line = state(&d, i).status.as_ref().expect("the unstar's line");
    assert_eq!(
        (line.sentence.as_str(), line.action_label.as_str()),
        ("Star removed", "Undo")
    );
}

#[test]
fn move_offers_every_folder_by_its_path_and_the_folder_it_is_in_is_nothing() {
    let mut d = driver();
    let i = root(&d);
    let taxes = folder(&d, "Taxes", None);
    folder(&d, "2026", Some(&taxes));
    let id = text(&d, "Return", "numbers");
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    row_menu(&mut d, i, &id);
    pick(&mut d, i, "move");
    let drive = state(&d, i);
    let sheet = drive.sheet.as_ref().unwrap();
    assert_eq!(sheet.title, "Move to");
    let Some(wire::docs_sheet::Body::Choices(list)) = &sheet.body else {
        panic!("the move sheet lists choices");
    };
    assert_eq!(list.choices[0].label, "Top level");
    assert!(list.choices[0].selected, "it is at the top level now");
    let labels: Vec<&str> = list.choices.iter().map(|c| c.label.as_str()).collect();
    assert!(labels.contains(&"Taxes / 2026"), "{labels:?}");
    // Where it already is: nothing to write.
    choose(&mut d, i, "top");
    assert!(state(&d, i).status.is_none());
    assert_eq!(row(d.view(i), "Return").folder_id, "");
    row_menu(&mut d, i, &id);
    pick(&mut d, i, "move");
    choose(&mut d, i, &taxes);
    assert_eq!(row(d.view(i), "Return").folder_id, taxes);
}

#[test]
fn labels_add_tags_a_label_it_has_is_nothing_and_remove_untags() {
    let mut d = driver();
    let i = root(&d);
    let tahoe = row(d.view(i), "Tahoe packing list").document_id.clone();
    row_menu(&mut d, i, &tahoe);
    pick(&mut d, i, "labels");
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Labels(labels)) = &sheet.body else {
        panic!("the labels sheet");
    };
    assert_eq!(labels.current.len(), 1);
    assert_eq!(labels.current[0].label, "tahoe");
    assert!(!labels.can_add);
    drive_send(
        &mut d,
        i,
        D::LabelDraft(de::LabelDraftEdited {
            text: "trip".to_owned(),
        }),
    );
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Labels(labels)) = &sheet.body else {
        panic!();
    };
    assert!(labels.can_add);
    drive_send(
        &mut d,
        i,
        D::LabelAdded(de::LabelAdded {
            label: " trip ".to_owned(),
        }),
    );
    let chips: Vec<&str> = row(d.view(i), "Tahoe packing list")
        .labels
        .iter()
        .map(|chip| chip.label.as_str())
        .collect();
    assert!(
        chips.contains(&"trip") && chips.contains(&"tahoe"),
        "{chips:?}"
    );
    // A label it has is nothing.
    drive_send(
        &mut d,
        i,
        D::LabelAdded(de::LabelAdded {
            label: "tahoe".to_owned(),
        }),
    );
    // No new write: the line is still the add's, with Undo (#1185).
    let line = state(&d, i).status.as_ref().expect("the add's line");
    assert_eq!(
        (line.sentence.as_str(), line.action_label.as_str()),
        ("Label added", "Undo")
    );
    let tag = row(d.view(i), "Tahoe packing list")
        .labels
        .iter()
        .find(|chip| chip.label == "trip")
        .unwrap()
        .tag_id
        .clone();
    drive_send(&mut d, i, D::LabelRemoved(de::LabelRemoved { tag_id: tag }));
    let chips: Vec<&str> = row(d.view(i), "Tahoe packing list")
        .labels
        .iter()
        .map(|chip| chip.label.as_str())
        .collect();
    assert_eq!(chips, ["tahoe"]);
}

#[test]
fn trash_asks_first_says_it_can_be_restored_and_dismissing_writes_nothing() {
    let mut d = driver();
    let i = root(&d);
    let id = text(&d, "Scratch", "x");
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    row_menu(&mut d, i, &id);
    pick(&mut d, i, "trash");
    let confirm_now = state(&d, i).confirm.as_ref().expect("a confirm");
    assert_eq!(confirm_now.title, "Move to trash?");
    assert_eq!(
        confirm_now.body,
        "It can be restored from trash for 30 days."
    );
    assert_eq!(confirm_now.confirm_label, "Move to trash");
    assert!(confirm_now.destructive);
    drive_send(&mut d, i, D::Dismissed(de::Dismissed {}));
    assert!(state(&d, i).confirm.is_none());
    assert!(titles(d.view(i)).contains(&"Scratch".to_owned()));
    row_menu(&mut d, i, &id);
    pick(&mut d, i, "trash");
    confirm(&mut d, i);
    assert!(state(&d, i).confirm.is_none());
    assert!(!titles(d.view(i)).contains(&"Scratch".to_owned()));
}

#[test]
fn rename_is_inline_and_autosaves_debounced_blank_refused_close_saves() {
    let mut d = driver();
    let i = root(&d);
    let id = text(&d, "Draft", "x");
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    row_menu(&mut d, i, &id);
    pick(&mut d, i, "rename");
    let rename = state(&d, i).rename.as_ref().expect("a rename is open");
    assert_eq!(rename.document_id, id);
    assert_eq!(rename.title, "Draft");
    // Typing is not a write: the title is the member's on the row, and the
    // vault still holds the old one until the debounce.
    drive_send(
        &mut d,
        i,
        D::RenameEdited(de::RenameEdited {
            title: "Final".to_owned(),
        }),
    );
    assert_eq!(row(d.view(i), "Final").document_id, id);
    assert_eq!(state(&d, i).rename.as_ref().unwrap().status_label, "Edited");
    assert_eq!(document(&d, &id).document.unwrap().title, "Draft");
    // The debounce comes due: one save.
    d.pump(std::time::Duration::from_millis(1300));
    assert_eq!(document(&d, &id).document.unwrap().title, "Final");
    // A blank name is refused with a sentence and the words stay.
    drive_send(
        &mut d,
        i,
        D::RenameEdited(de::RenameEdited {
            title: "  ".to_owned(),
        }),
    );
    d.pump(std::time::Duration::from_millis(1300));
    assert_eq!(document(&d, &id).document.unwrap().title, "Final");
    assert_eq!(
        state(&d, i).rename.as_ref().unwrap().status_label,
        "A document needs a name."
    );
    // Close = done: what is unsaved is saved on the way out.
    drive_send(
        &mut d,
        i,
        D::RenameEdited(de::RenameEdited {
            title: "Closed".to_owned(),
        }),
    );
    drive_send(&mut d, i, D::RenameClosed(de::RenameClosed {}));
    assert!(state(&d, i).rename.is_none());
    assert_eq!(document(&d, &id).document.unwrap().title, "Closed");
}

#[test]
fn a_folder_page_shows_its_children_its_crumbs_and_makes_a_folder_inside_it() {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let inner = folder(&d, "2026", Some(&taxes));
    let root_i = root(&d);
    band(&mut d, root_i, "folders");
    let names: Vec<String> = drive_data(d.view(root_i))
        .folders
        .iter()
        .map(|folder| folder.name.clone())
        .collect();
    assert!(names.contains(&"Taxes".to_owned()), "{names:?}");
    assert!(
        !names.contains(&"2026".to_owned()),
        "the Folders tab shows the top level only"
    );
    // A folder is a pushed page: its node carries the route.
    let node = drive_data(d.view(root_i))
        .folders
        .iter()
        .find(|folder| folder.name == "Taxes")
        .unwrap()
        .clone();
    let page = d.push(docs::TAB, node.route.clone().unwrap());
    let drive = state(&d, page);
    assert_eq!(drive.chrome.as_ref().unwrap().title, "Taxes");
    // A folder page carries the same filter menu (it holds no chip row of its own).
    assert!(drive.filter_menu.is_some());
    assert_eq!(drive.chrome.as_ref().unwrap().back, "Browse");
    let data = drive_data(d.view(page));
    assert_eq!(data.folders.len(), 1);
    assert_eq!(data.folders[0].name, "2026");
    assert_eq!(data.folders[0].count_label, "Empty");
    assert_eq!(
        state(&d, page)
            .crumbs
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["Taxes"]
    );
    assert!(
        state(&d, page).page.as_ref().unwrap().state.is_none(),
        "a folder with a child folder is not empty"
    );
    // A new folder lands inside the folder open.
    open_sheet(&mut d, page, Sheet::Add);
    pick(&mut d, page, "new_folder");
    let sheet = state(&d, page).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::NewFolder(new)) = &sheet.body else {
        panic!("the new-folder sheet");
    };
    assert_eq!(new.where_label, "In Taxes");
    assert!(!new.can_create);
    drive_send(
        &mut d,
        page,
        D::FolderName(de::FolderNameEdited {
            name: "2027".to_owned(),
        }),
    );
    drive_send(&mut d, page, D::FolderCreated(de::FolderCreated {}));
    let names: Vec<String> = drive_data(d.view(page))
        .folders
        .iter()
        .map(|folder| folder.name.clone())
        .collect();
    assert!(names.contains(&"2027".to_owned()), "{names:?}");
    // The deeper page names this page as its parent.
    let deeper = d.push(
        docs::TAB,
        routes::folder(
            &inner,
            "2026",
            &state(&d, page).chrome.as_ref().unwrap().title,
        ),
    );
    assert_eq!(state(&d, deeper).chrome.as_ref().unwrap().back, "Taxes");
    // An empty folder still shows the way back up.
    let crumbs: Vec<&str> = state(&d, deeper)
        .crumbs
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(crumbs, ["Taxes", "2026"]);
    assert_eq!(
        drive_empty(d.view(deeper)).headline,
        "This folder is empty."
    );
}

#[test]
fn the_add_sheet_rows_follow_the_os_grants_as_state() {
    let mut d = driver();
    let i = root(&d);
    open_sheet(&mut d, i, Sheet::Add);
    assert_eq!(
        sheet_keys(state(&d, i)),
        ["upload", "follow_folder", "scan", "text", "new_folder"]
    );
    let report = |d: &mut Driver, surface, permission| {
        drive_send(
            d,
            i,
            D::Permission(de::PermissionChanged {
                surface: surface as i32,
                permission: permission as i32,
            }),
        );
    };
    use de::permission_changed::Surface;
    report(&mut d, Surface::Camera, wire::DocsPermission::Denied);
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Actions(list)) = &sheet.body else {
        panic!();
    };
    let scan = list.actions.iter().find(|a| a.key == "scan").unwrap();
    assert!(!scan.enabled);
    assert_eq!(scan.detail, "Camera access is off. Turn it on in Settings.");
    report(&mut d, Surface::Camera, wire::DocsPermission::Unavailable);
    report(&mut d, Surface::Files, wire::DocsPermission::Restricted);
    assert_eq!(
        sheet_keys(state(&d, i)),
        ["upload", "follow_folder", "text", "new_folder"],
        "no camera: the Scan row is hidden"
    );
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Actions(list)) = &sheet.body else {
        panic!();
    };
    let upload = list.actions.iter().find(|a| a.key == "upload").unwrap();
    assert!(!upload.enabled);
    assert_eq!(upload.detail, "File access is blocked on this phone.");
}

/// The drive with two folders the vault follows (as `imports.files` records them), open on the
/// Followed folders sheet.
fn following_two() -> (Driver, u64) {
    let mut d = driver();
    let i = root(&d);
    band(&mut d, i, "more");
    assert!(
        !sheet_keys(state(&d, i)).contains(&"followed".to_owned()),
        "nothing followed: no Followed folders row, so no stop row"
    );
    for (origin, label) in [("folder:abc", "Scans"), ("folder:def", "Receipts")] {
        arrange(
            &d,
            act::shell::FollowFiles {
                origin: serde_json::json!({ "ref": origin, "label": label, "fills": null })
                    .to_string(),
                records: "[]".to_owned(),
                complete: Some(false),
            },
        );
    }
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    assert!(sheet_keys(state(&d, i)).contains(&"followed".to_owned()));
    pick(&mut d, i, "followed");
    (d, i)
}

fn followed_labels(d: &Driver, i: u64) -> Vec<String> {
    let sheet = state(d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Actions(list)) = &sheet.body else {
        panic!();
    };
    list.actions
        .iter()
        .map(|action| action.label.clone())
        .collect()
}

#[test]
fn a_followed_folder_is_a_stop_row_in_the_shared_words_and_tapping_it_asks_first() {
    let (mut d, i) = following_two();
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    assert_eq!(sheet.title, "Followed folders");
    let Some(wire::docs_sheet::Body::Actions(list)) = &sheet.body else {
        panic!();
    };
    // In the name's order, as the vault lists them, in the words every followed store shares.
    assert_eq!(list.actions[0].label, "Stop reading Receipts");
    assert_eq!(list.actions[1].label, "Stop reading Scans");
    assert_eq!(
        list.footer,
        "Files added, changed or removed in these folders reach Docs. Stopping keeps every document."
    );
    assert!(state(&d, i).stop.is_none());

    // Tapping a row stops nothing yet: the sheet goes and the kit's confirm asks, naming the folder.
    d.effects.clear();
    pick(&mut d, i, "stop:folder:abc");
    assert!(waiting(&d).is_empty(), "asked first: {:?}", waiting(&d));
    assert!(matches!(
        state(&d, i).sheet.as_ref().unwrap().kind(),
        Sheet::None
    ));
    let confirm = state(&d, i).stop.clone().expect("asked first");
    assert_eq!(confirm.title, "Stop reading Scans?");
    assert_eq!(
        confirm.body,
        "Docs stops reading Scans on this phone. The documents already here stay."
    );
    assert_eq!(confirm.confirm_label, "Stop reading");
    assert!(confirm.destructive);
    // The trash confirm is its own and is not up.
    assert!(state(&d, i).confirm.is_none());
}

#[test]
fn dismissing_the_stop_confirm_keeps_following_and_confirming_stops_the_folder() {
    let (mut d, i) = following_two();
    d.effects.clear();
    pick(&mut d, i, "stop:folder:abc");
    drive_send(&mut d, i, D::StopDismissed(de::StopDismissed {}));
    assert!(state(&d, i).stop.is_none());
    assert!(waiting(&d).is_empty(), "dismissing stops nothing");
    // Both folders are still followed.
    band(&mut d, i, "more");
    pick(&mut d, i, "followed");
    assert_eq!(
        followed_labels(&d, i),
        ["Stop reading Receipts", "Stop reading Scans"]
    );

    // Confirming runs the existing stop: the shell forgets its access, the vault the folder's links.
    pick(&mut d, i, "stop:folder:abc");
    drive_send(&mut d, i, D::StopConfirmed(de::StopConfirmed {}));
    let asked = waiting(&d);
    assert!(
        matches!(
            asked.first().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::StopFollowing(stop)) if stop.origin == "folder:abc"
        ),
        "{asked:?}"
    );
    assert_eq!(asked.len(), 1);
    assert!(state(&d, i).stop.is_none());
    band(&mut d, i, "more");
    pick(&mut d, i, "followed");
    assert_eq!(followed_labels(&d, i), ["Stop reading Receipts"]);

    // A confirm that was never asked stops nothing.
    d.effects.clear();
    drive_send(&mut d, i, D::StopConfirmed(de::StopConfirmed {}));
    assert!(waiting(&d).is_empty());
}

#[test]
fn the_trash_row_of_more_is_a_route_with_the_count_beside_it() {
    let mut d = driver();
    let i = root(&d);
    let id = text(&d, "Gone soon", "x");
    arrange(&d, act::docs::Trash { document_id: id });
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    band(&mut d, i, "more");
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Actions(list)) = &sheet.body else {
        panic!();
    };
    let trash = list
        .actions
        .iter()
        .find(|a| a.key == "trash_shelf")
        .unwrap();
    assert_eq!(trash.label, "Trash");
    assert_eq!(trash.detail, "1 document");
    assert_eq!(trash.meta, "30 days, then erased");
    assert_eq!(trash.route.as_ref().unwrap().screen, docs::TRASH);
}

// ---------------------------------------------------------------------------
// The redesign (#1173): Recents · Browse · Starred, label chips, coloured labels
// ---------------------------------------------------------------------------

fn chips(d: &Driver, i: u64) -> Vec<(String, String, bool)> {
    drive_data(d.view(i))
        .label_chips
        .iter()
        .map(|chip| (chip.label.clone(), chip.color_key.clone(), chip.selected))
        .collect()
}

#[test]
fn the_band_reads_recents_browse_starred_and_each_page_names_itself() {
    let mut d = driver();
    let i = root(&d);
    let drive = state(&d, i);
    let labels: Vec<&str> = drive.band.iter().map(|tab| tab.label.as_str()).collect();
    assert_eq!(labels, ["Recents", "Browse", "Starred", "More"]);
    assert_eq!(drive.chrome.as_ref().unwrap().title, "Recents");
    // Recents says what it is and how many there are; the seeded vault holds three live documents.
    assert_eq!(drive.head_meta, "Changed lately \u{b7} 3 documents in Docs");
    // The grid is the default layout.
    assert_eq!(drive.layout, wire::docs_drive_state::Layout::Grid as i32);
    band(&mut d, i, "folders");
    assert_eq!(state(&d, i).chrome.as_ref().unwrap().title, "Browse");
    band(&mut d, i, "starred");
    assert_eq!(state(&d, i).chrome.as_ref().unwrap().title, "Starred");
}

#[test]
fn recents_lists_the_newest_changed_first() {
    let mut d = driver();
    let i = root(&d);
    let old = text(&d, "Zeta old", "a");
    let newer = text(&d, "Alpha newer", "b");
    // Changing the older one makes it the most recent change.
    arrange(
        &d,
        act::docs::Edit {
            document_id: old,
            body_text: Some("changed".to_owned()),
            title: None,
            expected_rev: None,
        },
    );
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    let order = titles(d.view(i));
    assert_eq!(order[0], "Zeta old", "{order:?}");
    assert_eq!(order[1], "Alpha newer", "{order:?}");
    let _ = newer;
}

#[test]
fn a_label_is_coloured_from_the_palette_and_the_chips_filter_the_shelf() {
    let mut d = driver();
    let i = root(&d);
    let a = text(&d, "Lease", "x");
    let b = text(&d, "Receipt", "y");
    for (document, label) in [(&a, "taxes"), (&a, "home"), (&b, "receipts")] {
        arrange(
            &d,
            act::docs::Tag {
                document_id: document.clone(),
                label: label.to_owned(),
                color: None,
            },
        );
    }
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    let shown = chips(&d, i);
    let palette = centraid_design::tokens::LIST_IDS;
    // Every chip wears a palette key, none is selected, and the labels this drive minted
    // (tahoe from the seed, then three) spread over the palette before any colour repeats.
    assert!(
        shown
            .iter()
            .all(|(_, key, on)| palette.contains(&key.as_str()) && !on)
    );
    let mut keys: Vec<&str> = shown.iter().map(|(_, key, _)| key.as_str()).collect();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), shown.len(), "{shown:?}");
    // A row's dot is its first label's colour, and its chips carry the same keys.
    let lease = row(d.view(i), "Lease").clone();
    assert!(!lease.dot_color_key.is_empty());
    assert_eq!(lease.dot_color_key, lease.labels[0].color_key);
    // Tapping a chip filters the shelf to it and marks it; tapping it again clears it.
    drive_send(
        &mut d,
        i,
        D::LabelChip(de::LabelChipPicked {
            label: "receipts".to_owned(),
        }),
    );
    assert_eq!(titles(d.view(i)), ["Receipt"]);
    assert!(
        chips(&d, i)
            .iter()
            .any(|(label, _, on)| label == "receipts" && *on)
    );
    assert!(state(&d, i).filter_menu.as_ref().unwrap().filtering);
    drive_send(
        &mut d,
        i,
        D::LabelChip(de::LabelChipPicked {
            label: "receipts".to_owned(),
        }),
    );
    assert!(titles(d.view(i)).len() > 1);
    assert!(chips(&d, i).iter().all(|(_, _, on)| !on));
}

#[test]
fn a_label_colour_set_by_the_vault_reaches_the_row_and_the_labels_sheet() {
    let mut d = driver();
    let i = root(&d);
    let id = text(&d, "Passport", "x");
    arrange(
        &d,
        act::docs::Tag {
            document_id: id.clone(),
            label: "id".to_owned(),
            color: Some(centraid_screens::catalog::act::docs::TagColor::Orchid),
        },
    );
    arrange(
        &d,
        act::docs::RecolorLabel {
            label: "id".to_owned(),
            color: centraid_screens::catalog::act::docs::RecolorLabelColor::Raspberry,
        },
    );
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    let passport = row(d.view(i), "Passport").clone();
    assert_eq!(passport.labels[0].color_key, "raspberry");
    assert_eq!(passport.dot_color_key, "raspberry");
    row_menu(&mut d, i, &id);
    pick(&mut d, i, "labels");
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Labels(labels)) = &sheet.body else {
        panic!("the labels sheet");
    };
    assert_eq!(labels.current[0].color_key, "raspberry");
}

#[test]
fn the_screens_palette_is_the_vaults_and_a_label_without_a_stored_colour_gets_a_stable_one() {
    assert_eq!(
        centraid_design::tokens::LIST_IDS,
        centraid_vault::commands::tag::LABEL_COLORS
    );
    let first = docs::fold::color_key("", "tag:old");
    assert!(centraid_design::tokens::LIST_IDS.contains(&first.as_str()));
    assert_eq!(first, docs::fold::color_key("", "tag:old"));
    assert_eq!(docs::fold::color_key("orchid", "tag:old"), "orchid");
    // A stored colour that is not a palette key is mapped onto one, red onto raspberry (red means a state).
    assert_eq!(docs::fold::color_key("#ff0000", "tag:old"), "raspberry");
}

#[test]
fn the_starred_shelf_is_only_what_is_starred_and_stars_have_no_amber() {
    let mut d = driver();
    let i = root(&d);
    let one = text(&d, "One", "1");
    let two = text(&d, "Two", "2");
    for id in [&one, &two] {
        arrange(
            &d,
            act::docs::Star {
                document_id: id.clone(),
            },
        );
    }
    band(&mut d, i, "starred");
    let shelf = titles(d.view(i));
    assert_eq!(shelf.len(), 3, "the seed's one and these two: {shelf:?}");
    assert!(shelf.contains(&"One".to_owned()) && shelf.contains(&"Two".to_owned()));
    assert!(drive_data(d.view(i)).rows.iter().all(|row| row.starred));
    arrange(&d, act::docs::Unstar { document_id: one });
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    assert!(!titles(d.view(i)).contains(&"One".to_owned()));
}

#[test]
fn a_document_without_its_bytes_here_has_no_thumbnail_and_a_badge_from_its_name() {
    let mut d = driver();
    let i = root(&d);
    pdf(&d, "Passport scan.pdf", 'c');
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    let scan = row(d.view(i), "Passport scan.pdf").clone();
    assert_eq!(scan.badge, "PDF");
    assert!(
        scan.thumbnail_path.is_empty(),
        "the bytes were never stored"
    );
    let tahoe = row(d.view(i), "Tahoe packing list");
    assert!(!tahoe.badge.is_empty() && tahoe.badge.len() <= 4);
}

#[test]
fn a_rename_over_a_document_that_changed_elsewhere_is_refused_and_reload_shows_its_title() {
    let mut d = driver();
    let i = root(&d);
    let id = text(&d, "Draft", "x");
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    row_menu(&mut d, i, &id);
    pick(&mut d, i, "rename");
    arrange(
        &d,
        act::docs::Rename {
            document_id: id.clone(),
            title: "Elsewhere".to_owned(),
            expected_rev: None,
        },
    );
    drive_send(
        &mut d,
        i,
        D::RenameEdited(de::RenameEdited {
            title: "Mine".to_owned(),
        }),
    );
    d.pump(std::time::Duration::from_millis(1300));
    assert_eq!(document(&d, &id).document.unwrap().title, "Elsewhere");
    let rename = state(&d, i).rename.clone().expect("the rename stays open");
    assert_eq!(rename.status_label, "This document changed somewhere else.");
    assert_eq!(rename.autosave.unwrap().reload_label, "Reload");
    d.send(
        i,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
    let rename = state(&d, i).rename.clone().expect("still open");
    assert_eq!(rename.title, "Elsewhere");
    assert_eq!(rename.status_label, "Your text is in Earlier versions.");
}
