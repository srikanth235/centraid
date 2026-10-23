//! Docs' drive (`docs.drive`): ports of the `DocsSpec` drive cases — the shelves,
//! the band, the chip row, search, the row menu, move, labels, rename, a folder
//! page and the Add sheet — through `Driver`, the door a shell uses.

mod docs_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::docs::{self, routes};
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
    assert_eq!(drive.chrome.as_ref().unwrap().title, "Docs");
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
    assert!(drive.head_meta.ends_with("documents"), "{}", drive.head_meta);
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
    assert!(drive.head_meta.starts_with("1 document"), "{}", drive.head_meta);
    // The same tab again changes nothing and reads nothing new.
    band(&mut d, i, "starred");
    assert_eq!(titles(d.view(i)), ["Tahoe packing list"]);
    band(&mut d, i, "more");
    assert_eq!(
        sheet_keys(state(&d, i)),
        ["recent", "trash_shelf"],
        "More lists Recently added and Trash; Followed only once a folder is followed"
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
    assert_eq!(args.parent, "Docs");
}

#[test]
fn filters_are_the_requests_and_the_chip_row_follows_them() {
    let mut d = driver();
    let i = root(&d);
    let all = titles(d.view(i)).len();
    pdf(&d, "Lease.pdf", 'a');
    drive_send(&mut d, i, D::Refreshed(de::Refreshed {}));
    let pills: Vec<&str> = state(&d, i)
        .pills
        .iter()
        .map(|pill| pill.label.as_str())
        .collect();
    assert_eq!(pills.first(), Some(&"Type"));
    assert_eq!(pills.last(), Some(&"Date changed · Newest first"));
    open_sheet(&mut d, i, Sheet::Type);
    assert_eq!(sheet_keys(state(&d, i))[0], "any");
    choose(&mut d, i, "pdf");
    assert_eq!(titles(d.view(i)), ["Lease.pdf"]);
    let drive = state(&d, i);
    assert!(drive.filters_active);
    let pills: Vec<(&str, bool)> = drive
        .pills
        .iter()
        .map(|pill| (pill.label.as_str(), pill.active))
        .collect();
    assert_eq!(pills[0], ("PDFs", true));
    assert!(drive.pills.iter().any(|pill| pill.clears));
    // Clear filters reads the shelf back and keeps the order.
    drive_send(&mut d, i, D::FiltersCleared(de::FiltersCleared {}));
    assert_eq!(titles(d.view(i)).len(), all + 1);
    assert!(!state(&d, i).filters_active);
    // A filter nothing matches is its own empty state with the one action.
    open_sheet(&mut d, i, Sheet::Type);
    choose(&mut d, i, "video");
    let data = drive_data(d.view(i));
    assert_eq!(data.empty.as_ref().unwrap().headline, "Nothing matches these filters.");
    assert_eq!(data.empty.as_ref().unwrap().action_label, "Clear filters");
    assert_eq!(data.empty_action, wire::docs_drive_data::EmptyAction::ClearFilters as i32);
}

#[test]
fn the_sort_chip_is_named_for_the_order_in_force_and_follows_it() {
    let mut d = driver();
    let i = root(&d);
    open_sheet(&mut d, i, Sheet::Sort);
    choose(&mut d, i, "name_asc");
    let titles_now = titles(d.view(i));
    let mut sorted = titles_now.clone();
    sorted.sort_by_key(|title| title.to_lowercase());
    assert_eq!(titles_now, sorted);
    assert_eq!(
        state(&d, i).pills.last().unwrap().label,
        "Name · A to Z"
    );
    open_sheet(&mut d, i, Sheet::Sort);
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Choices(list)) = &sheet.body else {
        panic!("the sort sheet lists choices");
    };
    assert!(list.choices.iter().find(|c| c.key == "name_asc").unwrap().selected);
}

#[test]
fn recently_added_is_a_window_with_no_filters_and_its_rule_said_once() {
    let mut d = driver();
    let i = root(&d);
    open_sheet(&mut d, i, Sheet::Type);
    choose(&mut d, i, "pdf");
    band(&mut d, i, "more");
    pick(&mut d, i, "recent");
    let drive = state(&d, i);
    assert_eq!(drive.destination, wire::DocsDestination::Recent as i32);
    assert_eq!(drive.chrome.as_ref().unwrap().title, "Recently added");
    assert!(drive.pills.is_empty());
    assert!(!drive.filters_active);
    assert_eq!(drive_data(d.view(i)).shelf_note, "Most recently added documents.");
    assert!(!titles(d.view(i)).is_empty(), "the filter did not apply");
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
    assert!(data.rows.iter().any(|row| row.title == "Tahoe packing list"));
    assert!(data.rows.iter().all(|row| !row.snippet.is_empty()));
    // The Ask row for the answered term, scoped to Docs, matched or not.
    let ask = state(&d, i).search.as_ref().unwrap().ask_row.as_ref().unwrap();
    assert_eq!(ask.label, "Ask about “tahoe”");
    assert_eq!(ask.question, "Find tahoe");
    assert_eq!(ask.scope, "docs");
    // The band and the pills stay out of search's way.
    assert!(state(&d, i).pills.is_empty());
    // A term cleared to nothing reads the shelf back under the field.
    search(&mut d, i, "  ");
    assert_eq!(drive_data(d.view(i)).mode, wire::docs_drive_data::Mode::Shelf as i32);
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
    let data = drive_data(d.view(i));
    assert!(data.rows.is_empty());
    assert_eq!(data.empty.as_ref().unwrap().headline, "Nothing matches that.");
    assert_eq!(data.empty.as_ref().unwrap().body, "Try fewer words.");
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
    let data = drive_data(d.view(i));
    let empty = data.empty.as_ref().expect("an empty state");
    assert_eq!(empty.headline, "Nothing starred yet.");
    assert_eq!(empty.body, "Star a document to keep it here.");
    assert_eq!(data.empty_action, wire::docs_drive_data::EmptyAction::None as i32);
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
    assert!(matches!(state(&d, i).sheet.as_ref().unwrap().kind(), Sheet::None));
    row_menu(&mut d, i, &id);
    assert_eq!(sheet_keys(state(&d, i))[0], "unstar");
    pick(&mut d, i, "unstar");
    assert!(!row(d.view(i), "Notes").starred);
    // A document trashed under the page: the write is refused, the rows stay,
    // and the sentence is over them.
    row_menu(&mut d, i, &id);
    arrange(&d, act::docs::Trash { document_id: id.clone() });
    // The sheet follows the re-read: its row is gone, so is the sheet.
    d.pump(std::time::Duration::from_millis(200));
    assert!(matches!(state(&d, i).sheet.as_ref().unwrap().kind(), Sheet::None));
    assert!(state(&d, i).status.is_none());
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
    drive_send(&mut d, i, D::LabelDraft(de::LabelDraftEdited { text: "trip".to_owned() }));
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::Labels(labels)) = &sheet.body else {
        panic!();
    };
    assert!(labels.can_add);
    drive_send(&mut d, i, D::LabelAdded(de::LabelAdded { label: " trip ".to_owned() }));
    let chips: Vec<&str> = row(d.view(i), "Tahoe packing list")
        .labels
        .iter()
        .map(|chip| chip.label.as_str())
        .collect();
    assert!(chips.contains(&"trip") && chips.contains(&"tahoe"), "{chips:?}");
    // A label it has is nothing.
    drive_send(&mut d, i, D::LabelAdded(de::LabelAdded { label: "tahoe".to_owned() }));
    assert!(state(&d, i).status.is_none());
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
    assert_eq!(confirm_now.body, "It can be restored from trash for 30 days.");
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
    drive_send(&mut d, i, D::RenameEdited(de::RenameEdited { title: "Final".to_owned() }));
    assert_eq!(row(d.view(i), "Final").document_id, id);
    assert_eq!(state(&d, i).rename.as_ref().unwrap().status_label, "Edited");
    assert_eq!(document(&d, &id).document.unwrap().title, "Draft");
    // The debounce comes due: one save.
    d.pump(std::time::Duration::from_millis(1300));
    assert_eq!(document(&d, &id).document.unwrap().title, "Final");
    // A blank name is refused with a sentence and the words stay.
    drive_send(&mut d, i, D::RenameEdited(de::RenameEdited { title: "  ".to_owned() }));
    d.pump(std::time::Duration::from_millis(1300));
    assert_eq!(document(&d, &id).document.unwrap().title, "Final");
    assert_eq!(
        state(&d, i).rename.as_ref().unwrap().status_label,
        "A document needs a name."
    );
    // Close = done: what is unsaved is saved on the way out.
    drive_send(&mut d, i, D::RenameEdited(de::RenameEdited { title: "Closed".to_owned() }));
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
    assert_eq!(drive.chrome.as_ref().unwrap().back, "Docs");
    let data = drive_data(d.view(page));
    assert_eq!(data.folders.len(), 1);
    assert_eq!(data.folders[0].name, "2026");
    assert_eq!(data.folders[0].count_label, "Empty");
    assert_eq!(data.crumbs.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Taxes"]);
    assert_eq!(data.empty, None, "a folder with a child folder is not empty");
    // A new folder lands inside the folder open.
    open_sheet(&mut d, page, Sheet::Add);
    pick(&mut d, page, "new_folder");
    let sheet = state(&d, page).sheet.as_ref().unwrap();
    let Some(wire::docs_sheet::Body::NewFolder(new)) = &sheet.body else {
        panic!("the new-folder sheet");
    };
    assert_eq!(new.where_label, "In Taxes");
    assert!(!new.can_create);
    drive_send(&mut d, page, D::FolderName(de::FolderNameEdited { name: "2027".to_owned() }));
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
        routes::folder(&inner, "2026", &state(&d, page).chrome.as_ref().unwrap().title),
    );
    assert_eq!(state(&d, deeper).chrome.as_ref().unwrap().back, "Taxes");
    let crumbs: Vec<&str> = drive_data(d.view(deeper))
        .crumbs
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(crumbs, ["Taxes", "2026"]);
    assert!(drive_data(d.view(deeper)).empty.is_some());
    assert_eq!(
        drive_data(d.view(deeper)).empty.as_ref().unwrap().headline,
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

#[test]
fn a_followed_folder_is_a_stop_row_and_stopping_asks_the_shell_to_forget_it() {
    let mut d = driver();
    let i = root(&d);
    band(&mut d, i, "more");
    assert!(!sheet_keys(state(&d, i)).contains(&"followed".to_owned()));
    drive_send(
        &mut d,
        i,
        D::FollowedChanged(de::FollowedChanged {
            followed: vec![
                wire::DocsFollowed {
                    origin_id: "folder:abc".to_owned(),
                    name: "Scans".to_owned(),
                    documents: 1,
                },
                wire::DocsFollowed {
                    origin_id: "folder:def".to_owned(),
                    name: "Receipts".to_owned(),
                    documents: 4,
                },
            ],
        }),
    );
    assert!(sheet_keys(state(&d, i)).contains(&"followed".to_owned()));
    pick(&mut d, i, "followed");
    let sheet = state(&d, i).sheet.as_ref().unwrap();
    assert_eq!(sheet.title, "Followed folders");
    let Some(wire::docs_sheet::Body::Actions(list)) = &sheet.body else {
        panic!();
    };
    assert_eq!(list.actions[0].label, "Stop following Scans");
    assert_eq!(list.actions[0].detail, "1 document stays in Docs");
    assert_eq!(list.actions[1].detail, "4 documents stay in Docs");
    assert_eq!(
        list.footer,
        "Files added, changed or removed in these folders reach Docs. Stopping keeps every document."
    );
    d.effects.clear();
    pick(&mut d, i, "stop:folder:abc");
    let asked = waiting(&d);
    assert!(
        matches!(
            asked.first().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::StopFollowing(stop)) if stop.origin == "folder:abc"
        ),
        "{asked:?}"
    );
    assert!(matches!(state(&d, i).sheet.as_ref().unwrap().kind(), Sheet::None));
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
    let trash = list.actions.iter().find(|a| a.key == "trash_shelf").unwrap();
    assert_eq!(trash.label, "Trash");
    assert_eq!(trash.detail, "1 document");
    assert_eq!(trash.route.as_ref().unwrap().screen, docs::TRASH);
}
