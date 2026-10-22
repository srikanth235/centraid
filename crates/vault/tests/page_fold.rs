//! THE GRID DRAWS AN EDIT AND KEEPS THE CAMERA'S ORIGINAL UNDERNEATH
//! (#1127, A20(1), R-1127-5; #1135).
//!
//! The fold is a predicate the mobile shell hands the page door
//! (`PhotoFold.LIVE`, Kotlin). This runs that exact text, read from the Kotlin
//! source, through the vault's door over real `photo` rows, so a predicate that
//! SQLite or the door would refuse — or that folds the wrong photograph — fails
//! here and not on a member's phone.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::page::KeysetPage;
use centraid_vault::{Command, CommandStatus, Principal, Value};
use serde_json::json;

const FOLD_SOURCE: &str = include_str!(
    "../../../mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotoFold.kt"
);

/// A raw-string constant of `PhotoFold`: what follows `const val NAME: String = """`.
fn constant(name: &str) -> String {
    let after = FOLD_SOURCE
        .split(&format!("const val {name}: String = \"\"\""))
        .nth(1)
        .unwrap_or_else(|| panic!("PhotoFold.kt declares {name} as a raw string"));
    after
        .split("\"\"\"")
        .next()
        .expect("the raw string closes")
        .to_owned()
}

/// `PhotoFold.LIVE`, spelled out from its three raw strings.
fn live() -> String {
    format!(
        "{} AND {} AND {}",
        constant("NOT_TRASHED"),
        constant("NOT_ARCHIVED"),
        constant("FOLDED")
    )
}

struct Library {
    scratch: common::Scratch,
    registry: Registry,
}

impl Library {
    fn new(seed: &str) -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs(seed).expect("a vault is founded"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
    }

    /// One photograph: its id, its form, its burst and what it was edited from.
    fn add(&self, id: &str, form: &str, burst: Option<&str>, from: Option<&str>) {
        let hash = centraid_vault::blob::content_digest(id.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": id.len() }));
        let media_type = if form == "video" {
            "video/mp4"
        } else {
            "image/jpeg"
        };
        self.ok(
            "photo.add",
            json!({ "id": id, "blob": hash, "media_type": media_type, "form": form,
                     "taken_at": "2019-08-03T10:11:12Z", "burst": burst, "edited_from": from }),
        );
        self.scratch.clock.advance_ms(1_000);
    }

    fn set(&self, id: &str, command: &str) {
        let input = if command == "flag.set" {
            json!({ "id": id, "flag": "archived" })
        } else {
            json!({ "id": id })
        };
        self.ok(command, input);
    }

    /// What the grid draws, through the door the shell reads by.
    fn drawn(&self) -> Vec<String> {
        let page = KeysetPage {
            name: "photos.grid.live".to_owned(),
            select: vec!["id".to_owned()],
            from: "photo".to_owned(),
            predicate: Some(live()),
            binds: Vec::new(),
            sort_column: "id".to_owned(),
            pk_column: "id".to_owned(),
            descending: false,
            limit: 50,
            after: None,
            held_thumbnail: false,
            document_size: false,
        };
        self.scratch
            .vault
            .keyset_page_reading_only(&page, &["photo", "entity", "edge"])
            .expect("the door serves the fold")
            .rows
            .iter()
            .map(|row| match row.get("id") {
                Some(Value::Text(id)) => id.clone(),
                other => panic!("a photograph id, not {other:?}"),
            })
            .collect()
    }
}

#[test]
fn the_edit_draws_and_the_original_stays_under_it() {
    let library = Library::new("fold-edit");
    library.add("orig", "photo", Some("G"), None);
    library.add("edit", "photo", Some("G"), Some("orig"));
    assert_eq!(library.drawn(), vec!["edit"]);
}

#[test]
fn trashing_or_archiving_the_edit_brings_the_original_back() {
    let library = Library::new("fold-revert");
    library.add("orig", "photo", Some("G"), None);
    library.add("edit", "photo", Some("G"), Some("orig"));
    library.set("edit", "flag.set");
    assert_eq!(library.drawn(), vec!["orig"]);
    library.ok("flag.clear", json!({ "id": "edit", "flag": "archived" }));
    assert_eq!(library.drawn(), vec!["edit"]);
    library.set("edit", "entity.trash");
    assert_eq!(library.drawn(), vec!["orig"]);
}

#[test]
fn a_second_edit_folds_the_first() {
    let library = Library::new("fold-second");
    library.add("a-orig", "photo", Some("G"), None);
    library.add("b-one", "photo", Some("G"), Some("a-orig"));
    library.add("c-two", "photo", Some("G"), Some("a-orig"));
    assert_eq!(library.drawn(), vec!["c-two"]);
}

#[test]
fn an_edit_wins_whatever_the_ids_say() {
    let library = Library::new("fold-ids");
    // The edit's id sorts BEFORE the original's: it folds the original by lineage.
    library.add("z-orig", "photo", Some("G"), None);
    library.add("a-edit", "photo", Some("G"), Some("z-orig"));
    assert_eq!(library.drawn(), vec!["a-edit"]);
}

#[test]
fn a_crop_saved_from_the_editor_and_an_ungrouped_photograph_both_draw() {
    let library = Library::new("fold-crop");
    // R-1029-PH-5: the editor's save is a new photograph the member chose to
    // make, with lineage and no burst. Both stay.
    library.add("plain", "photo", None, None);
    library.add("crop", "photo", None, Some("plain"));
    assert_eq!(library.drawn(), vec!["crop", "plain"]);
}

#[test]
fn a_live_photos_movie_is_not_folded_by_its_still() {
    let library = Library::new("fold-live");
    library.add("still", "photo", Some("L"), None);
    library.add("movie", "video", Some("L"), None);
    // The grid folds the movie into its still itself (`PhotosGridMachine.live`).
    assert_eq!(library.drawn(), vec!["movie", "still"]);
}

#[test]
fn a_file_edited_in_place_folds_its_ungrouped_earlier_version_by_lineage() {
    let library = Library::new("fold-android");
    // THE EARLIER VERSION WAS BACKED UP BEFORE THE EDIT EXISTED, so it has no
    // burst; the edit carries one and names it as its source.
    library.add("before", "photo", None, None);
    library.add("after", "photo", Some("image:7"), Some("before"));
    assert_eq!(library.drawn(), vec!["after"]);
    // A SECOND EDIT, whose source is the first.
    library.add("again", "photo", Some("image:7"), Some("after"));
    assert_eq!(library.drawn(), vec!["again"]);
    // Trashing the newest brings the one before it back, and no further.
    library.set("again", "entity.trash");
    assert_eq!(library.drawn(), vec!["after"]);
}

#[test]
fn a_crop_of_an_edit_folds_nothing() {
    let library = Library::new("fold-crop-of-edit");
    library.add("before", "photo", None, None);
    library.add("edit", "photo", Some("image:7"), Some("before"));
    // The editor's save of the edit: lineage, no burst.
    library.add("crop", "photo", None, Some("edit"));
    assert_eq!(library.drawn(), vec!["crop", "edit"]);
}
