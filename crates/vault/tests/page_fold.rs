//! THE GRID DRAWS AN EDIT AND KEEPS THE CAMERA'S ORIGINAL UNDERNEATH
//! (#1127, A20(1), R-1127-5).
//!
//! The fold is a predicate the mobile shell hands the page door
//! (`PhotoFold.FOLDED`, Kotlin). This runs that exact text, read from the
//! Kotlin source, through the vault's door over real `media_asset` rows, so a
//! predicate that SQLite or the door would refuse — or that folds the wrong
//! photograph — fails here and not on a member's phone.

mod common;

use centraid_vault::Value;
use centraid_vault::page::KeysetPage;

const FOLD_SOURCE: &str = include_str!(
    "../../../mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotoFold.kt"
);

/// `PhotoFold.FOLDED`: the raw string after `const val FOLDED: String = """`.
fn folded() -> String {
    let after = FOLD_SOURCE
        .split("const val FOLDED: String = \"\"\"")
        .nth(1)
        .expect("PhotoFold.kt declares FOLDED as a raw string");
    after
        .split("\"\"\"")
        .next()
        .expect("the raw string closes")
        .to_owned()
}

/// The library's live predicate with the fold, as `PhotoFold.LIVE` spells it.
fn live() -> String {
    format!(
        "deleted_at IS NULL AND archived_at IS NULL AND {}",
        folded()
    )
}

struct Library {
    scratch: common::Scratch,
}

impl Library {
    fn new(seed: &str) -> Self {
        Self {
            scratch: common::Scratch::founded(seed).expect("a vault is founded"),
        }
    }

    /// One asset: `(id, kind, group, source, created_at)`.
    fn add(&self, id: &str, kind: &str, group: Option<&str>, source: Option<&str>, created: &str) {
        let content_id = format!("content-{id}");
        let sha = centraid_vault::content::content_digest(id.as_bytes());
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, content_hash, byte_size, created_at)
                     VALUES (?1, ?2, ?3, 1024, ?4)",
                    rusqlite::params![content_id, format!("blob:{sha}"), sha, created],
                )?;
                tx.connection().execute(
                    "INSERT INTO media_asset
                       (asset_id, content_id, kind, captured_at, capture_group_id,
                        source_asset_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, '2019-08-03T10:11:12Z', ?4, ?5, ?6, ?6)",
                    rusqlite::params![id, content_id, kind, group, source, created],
                )?;
                Ok(())
            })
            .expect("the asset lands");
    }

    fn set(&self, id: &str, column: &str) {
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    &format!(
                        "UPDATE media_asset SET {column} = '2026-02-01T00:00:00.000Z' WHERE asset_id = ?1"
                    ),
                    [id],
                )?;
                Ok(())
            })
            .expect("the column moves");
    }

    /// What the grid draws, through the door the shell reads by.
    fn drawn(&self) -> Vec<String> {
        let page = KeysetPage {
            name: "photos.grid.live".to_owned(),
            select: vec!["asset_id".to_owned()],
            from: "media_asset".to_owned(),
            predicate: Some(live()),
            binds: Vec::new(),
            sort_column: "asset_id".to_owned(),
            pk_column: "asset_id".to_owned(),
            descending: false,
            limit: 50,
            after: None,
            held_thumbnail: false,
            note_body: false,
            document_size: false,
        };
        self.scratch
            .vault
            .keyset_page_reading_only(&page, &["media_asset", "core_tag"])
            .expect("the door serves the fold")
            .rows
            .iter()
            .map(|row| match row.get("asset_id") {
                Some(Value::Text(id)) => id.clone(),
                other => panic!("an asset id, not {other:?}"),
            })
            .collect()
    }
}

#[test]
fn the_edit_draws_and_the_original_stays_under_it() {
    let library = Library::new("fold-edit");
    library.add("orig", "photo", Some("G"), None, "2026-01-01T00:00:00.000Z");
    library.add(
        "edit",
        "photo",
        Some("G"),
        Some("orig"),
        "2026-01-02T00:00:00.000Z",
    );
    assert_eq!(library.drawn(), vec!["edit"]);
}

#[test]
fn trashing_or_archiving_the_edit_brings_the_original_back() {
    let library = Library::new("fold-revert");
    library.add("orig", "photo", Some("G"), None, "2026-01-01T00:00:00.000Z");
    library.add(
        "edit",
        "photo",
        Some("G"),
        Some("orig"),
        "2026-01-02T00:00:00.000Z",
    );
    library.set("edit", "archived_at");
    assert_eq!(library.drawn(), vec!["orig"]);
}

#[test]
fn a_second_edit_folds_the_first() {
    let library = Library::new("fold-second");
    library.add("orig", "photo", Some("G"), None, "2026-01-01T00:00:00.000Z");
    library.add(
        "one",
        "photo",
        Some("G"),
        Some("orig"),
        "2026-01-02T00:00:00.000Z",
    );
    library.add(
        "two",
        "photo",
        Some("G"),
        Some("orig"),
        "2026-01-03T00:00:00.000Z",
    );
    assert_eq!(library.drawn(), vec!["two"]);
}

#[test]
fn an_edit_wins_a_tie_on_the_clock_whatever_the_ids_say() {
    let library = Library::new("fold-tie");
    // The edit's id sorts BEFORE the original's, and they share a millisecond.
    library.add(
        "z-orig",
        "photo",
        Some("G"),
        None,
        "2026-01-01T00:00:00.000Z",
    );
    library.add(
        "a-edit",
        "photo",
        Some("G"),
        Some("z-orig"),
        "2026-01-01T00:00:00.000Z",
    );
    assert_eq!(library.drawn(), vec!["a-edit"]);
}

#[test]
fn a_crop_saved_from_the_editor_and_an_ungrouped_photograph_both_draw() {
    let library = Library::new("fold-crop");
    // R-1029-PH-5: the editor's save is a new photograph the member chose to
    // make, with lineage and no group. Both stay.
    library.add("plain", "photo", None, None, "2026-01-01T00:00:00.000Z");
    library.add(
        "crop",
        "photo",
        None,
        Some("plain"),
        "2026-01-02T00:00:00.000Z",
    );
    assert_eq!(library.drawn(), vec!["crop", "plain"]);
}

#[test]
fn a_live_photos_movie_is_not_folded_by_its_still() {
    let library = Library::new("fold-live");
    library.add(
        "still",
        "photo",
        Some("L"),
        None,
        "2026-01-01T00:00:00.000Z",
    );
    library.add(
        "movie",
        "video",
        Some("L"),
        None,
        "2026-01-01T00:00:00.000Z",
    );
    // The grid folds the movie into its still itself (`PhotosGridMachine.live`).
    assert_eq!(library.drawn(), vec!["movie", "still"]);
}

#[test]
fn a_file_edited_in_place_folds_its_ungrouped_earlier_version_by_lineage() {
    let library = Library::new("fold-android");
    // THE EARLIER VERSION WAS BACKED UP BEFORE THE EDIT EXISTED, so it has no
    // group; the edit carries one and names it as its source.
    library.add("before", "photo", None, None, "2026-01-01T00:00:00.000Z");
    library.add(
        "after",
        "photo",
        Some("image:7"),
        Some("before"),
        "2026-01-02T00:00:00.000Z",
    );
    assert_eq!(library.drawn(), vec!["after"]);
    // A SECOND EDIT, whose source is the first (the lookup answers the newest).
    library.add(
        "again",
        "photo",
        Some("image:7"),
        Some("after"),
        "2026-01-03T00:00:00.000Z",
    );
    assert_eq!(library.drawn(), vec!["again"]);
    // Trashing the newest brings the one before it back, and no further.
    library.set("again", "deleted_at");
    assert_eq!(library.drawn(), vec!["after"]);
}

#[test]
fn a_crop_of_an_edit_folds_nothing() {
    let library = Library::new("fold-crop-of-edit");
    library.add("before", "photo", None, None, "2026-01-01T00:00:00.000Z");
    library.add(
        "edit",
        "photo",
        Some("image:7"),
        Some("before"),
        "2026-01-02T00:00:00.000Z",
    );
    // The editor's save of the edit: lineage, no group.
    library.add(
        "crop",
        "photo",
        None,
        Some("edit"),
        "2026-01-03T00:00:00.000Z",
    );
    assert_eq!(library.drawn(), vec!["crop", "edit"]);
}
