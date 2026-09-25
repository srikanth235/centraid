//! THE PHONE'S READS (#1046): a denial is a state, and every shelf is cut
//! from the one window.

use centraid_apps_docs::phone::{Modified, RECENT_WINDOW, Shelf, Sort, View, shelve};
use centraid_apps_docs::queries::{
    DocumentRow, DriveData, DriveInput, FolderRow, LabelEntry, load_activity, load_document,
    load_drive, load_history,
};
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_vault::time::zone::FireZone;

/// A door that refuses every read, as a revoked grant would.
struct Refusing;

impl PageDoor for Refusing {
    fn page(&self, _query: &PageQuery, _request: &PageRequest) -> KitResult<Page<Row>> {
        Err(KitError::Door("the grant was revoked".to_owned()))
    }
}

/// A DENIED READ IS A STATE, NOT AN ERROR: every loader answers its empty
/// payload beside the denial, and never an `Err`.
#[test]
fn a_denied_door_answers_a_denial_from_every_loader() {
    let (drive, denial) = load_drive(&Refusing, DriveInput::default()).expect("not an error");
    assert!(drive.documents.is_empty() && drive.folders.is_empty());
    assert_eq!(
        denial.and_then(|denial| denial.message).as_deref(),
        Some("the grant was revoked")
    );
    let (document, denial) = load_document(&Refusing, "d1").expect("not an error");
    assert!(document.row.is_none() && document.body.is_none());
    assert!(denial.is_some());
    let (history, denial) = load_history(&Refusing, "d1").expect("not an error");
    assert!(history.versions.is_empty() && denial.is_some());
    let (activity, denial) = load_activity(&Refusing, "d1").expect("not an error");
    assert!(activity.events.is_empty() && denial.is_some());
}

fn row(id: &str, created: &str, trashed: bool) -> DocumentRow {
    DocumentRow {
        document_id: id.to_owned(),
        content_id: format!("c-{id}"),
        title: Some(id.to_owned()),
        media_type: Some("text/plain".to_owned()),
        byte_size: Some(1),
        content_uri: None,
        poster_uri: None,
        created_at: Some(created.to_owned()),
        updated_at: Some(created.to_owned()),
        folder_id: None,
        starred: false,
        trashed,
        deleted_at: trashed.then(|| created.to_owned()),
        purge_at: None,
        tags: Vec::new(),
        custody_state: None,
        snippet: None,
    }
}

fn zone() -> FireZone {
    FireZone::named("Etc/UTC").expect("a zone")
}

/// TRASH IS ITS OWN SHELF, and a folder counts its direct live children.
#[test]
fn the_trash_is_its_own_shelf_and_folders_count_live_rows() {
    let mut filed = row("filed", "2099-06-01T00:00:00.000Z", false);
    filed.folder_id = Some("f1".to_owned());
    filed.tags = vec![LabelEntry {
        tag_id: "t1".to_owned(),
        label: "Tax".to_owned(),
    }];
    let mut trashed_filed = row("gone", "2099-06-01T00:00:00.000Z", true);
    trashed_filed.folder_id = Some("f1".to_owned());
    trashed_filed.tags = vec![LabelEntry {
        tag_id: "t2".to_owned(),
        label: "Old".to_owned(),
    }];
    let drive = DriveData {
        folders: vec![FolderRow {
            folder_id: "f1".to_owned(),
            name: Some("Leases".to_owned()),
            parent_id: None,
        }],
        documents: vec![filed, trashed_filed],
        ..DriveData::default()
    };
    let now = 0;
    let all = shelve(&drive, &View::default(), &zone(), "2099-06-01", now);
    assert_eq!(all.documents.len(), 1);
    assert_eq!(all.folder_counts["f1"], 1, "a trashed child is not counted");
    assert_eq!(all.labels, ["Tax"], "a trashed row's label is no option");
    assert_eq!(all.trash_count, 1);
    let folder = shelve(
        &drive,
        &View {
            shelf: Shelf::Folder(Some("f1".to_owned())),
            ..View::default()
        },
        &zone(),
        "2099-06-01",
        now,
    );
    assert_eq!(folder.documents[0].document_id, "filed");
    let trash = shelve(
        &drive,
        &View {
            shelf: Shelf::Trash,
            ..View::default()
        },
        &zone(),
        "2099-06-01",
        now,
    );
    assert_eq!(trash.documents.len(), 1);
    assert_eq!(trash.documents[0].document_id, "gone");
}

/// RECENT IS A WINDOW OF FIFTY, in the drive's own order, whatever the sort.
#[test]
fn recent_is_a_window_in_the_drives_order() {
    let documents: Vec<DocumentRow> = (0..60)
        .map(|index| {
            row(
                &format!("d{index:02}"),
                &format!("2099-06-01T00:{index:02}:00.000Z"),
                false,
            )
        })
        .rev()
        .collect();
    let drive = DriveData {
        documents,
        ..DriveData::default()
    };
    let recent = shelve(
        &drive,
        &View {
            shelf: Shelf::Recent,
            sort: Sort::Name,
            ascending: true,
            ..View::default()
        },
        &zone(),
        "2099-06-01",
        0,
    );
    assert_eq!(recent.documents.len(), RECENT_WINDOW);
    assert_eq!(recent.documents[0].document_id, "d59", "newest first");
}

/// THE MODIFIED PILLS, in the request's zone: "Today" is the local day, "Last
/// 7 days" is a span of the vault clock, "This year" the local year.
#[test]
fn the_modified_pills_read_the_zone_and_the_clock() {
    let zone = FireZone::named("America/New_York").expect("a zone");
    // The clock: 02:00Z on 2 June 2099, which is 1 June, 22:00, in New York.
    let now = centraid_vault::time::recurrence::parse_instant_ms("2099-06-02T02:00:00.000Z")
        .expect("an instant");
    let drive = DriveData {
        documents: vec![
            // 23:30 on 1 June in New York — today there, tomorrow in UTC.
            row("late", "2099-06-02T03:30:00.000Z", false),
            row("week", "2099-05-28T12:00:00.000Z", false),
            row("month", "2099-05-10T12:00:00.000Z", false),
            row("january", "2099-01-02T12:00:00.000Z", false),
            row("lastyear", "2098-12-31T12:00:00.000Z", false),
        ],
        ..DriveData::default()
    };
    let ids = |modified: Modified| {
        let mut ids: Vec<String> = shelve(
            &drive,
            &View {
                modified: Some(modified),
                ..View::default()
            },
            &zone,
            "2099-06-01",
            now,
        )
        .documents
        .into_iter()
        .map(|row| row.document_id)
        .collect();
        ids.sort();
        ids
    };
    assert_eq!(ids(Modified::Today), ["late"]);
    assert_eq!(ids(Modified::Last7Days), ["late", "week"]);
    assert_eq!(ids(Modified::Last30Days), ["late", "month", "week"]);
    assert_eq!(
        ids(Modified::ThisYear),
        ["january", "late", "month", "week"]
    );
}
