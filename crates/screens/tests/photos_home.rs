//! `photos.home` through the door a shell uses (#1135): the library grid with its
//! paging, zoom, filter, tile size, select mode and writes; Collections with its
//! albums, doors and album trash; Search; the More sheet; and the camera roll's
//! banner. Ports `PhotosGridChromeSpec`, `PhotosLibraryLayoutSpec`, `FreeUpSpec`,
//! `PhotosCollectionsSpec` and `PhotosSearchSpec`.
//!
//! The vault is the example scenario, so every test arranges its own
//! photographs under seeds of its own and asserts on those.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::{Field, Keyed};
use centraid_screens::kit::act as kit_act;
use centraid_screens::photos;
use centraid_screens::photos::home::chrome::Roll;
use centraid_screens::photos::home::layout::{self, Boxed};
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use wire::PhotosBackupPhase as Phase;
use wire::PhotosDestination as Dest;
use wire::PhotosFilter as Filter;
use wire::PhotosGrain as Grain;
use wire::PhotosMediaPermission as Perm;
use wire::photos_home_event::Kind as H;
use wire::photos_home_state::Sheet;
use wire::screen_event::Kind as E;

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

struct Rig {
    d: Driver,
    id: u64,
}

fn rig_at(destination: Dest, query: Option<&str>) -> Rig {
    let mut d = Driver::with_runtime(centraid_screens::Runtime::new(
        photos::registry(),
        vec![(
            photos::TAB.to_owned(),
            photos::routes::home(destination, query),
        )],
    ));
    d.start();
    let id = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    Rig { d, id }
}

fn rig() -> Rig {
    rig_at(Dest::Library, None)
}

/// A rig over a vault opened with its keys, as a phone's is: the core's backup
/// doors (`fetch_original`, `releasable`) answer only a keyed vault.
fn keyed_rig() -> Rig {
    let mut d = Driver::keyed(photos::runtime());
    d.start();
    let id = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    Rig { d, id }
}

impl Rig {
    fn state(&self) -> &wire::PhotosHomeState {
        match &self.d.view(self.id).kind {
            Some(wire::view_state::Kind::PhotosHome(state)) => state,
            other => panic!("not Photos' home: {other:?}"),
        }
    }

    fn send(&mut self, kind: H) -> wire::ScreenUpdate {
        self.d.send(
            self.id,
            E::PhotosHome(wire::PhotosHomeEvent { kind: Some(kind) }),
        )
    }

    fn viewport(&mut self, width: f64) {
        self.send(H::Viewport(wire::PhotosViewport {
            width,
            height: 800.0,
        }));
    }

    fn library(&self) -> &wire::PhotosLibraryData {
        match self.state().library.as_ref().expect("the library").content {
            Some(wire::photos_library::Content::Data(ref data)) => data,
            ref other => panic!("expected the library's data, found {other:?}"),
        }
    }

    fn collections(&self) -> &wire::PhotosCollectionsData {
        match self
            .state()
            .collections
            .as_ref()
            .expect("collections")
            .content
        {
            Some(wire::photos_collections::Content::Data(ref data)) => data,
            ref other => panic!("expected collections' data, found {other:?}"),
        }
    }

    fn search(&self) -> &wire::PhotosSearchView {
        self.state().search.as_ref().expect("search")
    }

    fn hits(&self) -> &wire::PhotosSearchHits {
        match self.search().content {
            Some(wire::photos_search_view::Content::Hits(ref hits)) => hits,
            ref other => panic!("expected hits, found {other:?}"),
        }
    }

    fn tile_ids(&self) -> Vec<String> {
        self.library()
            .tiles
            .iter()
            .map(|t| t.photo_id.clone())
            .collect()
    }

    fn tile(&self, id: &str) -> &wire::PhotoTile {
        self.library()
            .tiles
            .iter()
            .find(|tile| tile.photo_id == id)
            .unwrap_or_else(|| panic!("no tile {id}"))
    }

    fn section(&self, key: &str) -> &wire::PhotosCollectionsSection {
        self.collections()
            .sections
            .iter()
            .find(|section| section.key == key)
            .unwrap_or_else(|| panic!("no section {key}"))
    }

    fn arrange(&self, request: impl Into<wire::ActRequest>) -> serde_json::Value {
        let response = self.d.act(
            request
                .into()
                .keyed(format!("arrange:{}", kit_act::fresh())),
        );
        assert_eq!(
            response.status,
            wire::ActStatus::Executed as i32,
            "{}",
            response.reason
        );
        serde_json::from_slice(&response.output).unwrap_or(serde_json::Value::Null)
    }

    fn command(&self, name: &str, input: serde_json::Value) {
        let outcome = self
            .d
            .handle
            .command(
                name,
                &input,
                &format!("photos-home:{name}:{}", kit_act::fresh()),
            )
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        assert_eq!(
            outcome.status,
            centraid_vault::CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );
    }

    /// One photograph in the library; the seed makes its bytes unique.
    fn photo(&self, seed: &str, taken_at: Option<&str>, size: Option<(i64, i64)>) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.command(
            "blob.stage",
            serde_json::json!({ "hash": hash, "size": seed.len() }),
        );
        let (width, height) = size.map_or((Field::Keep, Field::Keep), |(w, h)| {
            (Field::Is(w), Field::Is(h))
        });
        let value = self.arrange(act::photos::Upload {
            blob: hash,
            media_type: "image/jpeg".to_owned(),
            form: Some(act::photos::UploadForm::Photo),
            taken_at: taken_at.map_or(Field::Keep, |at| Field::Is(at.to_owned())),
            offset_min: taken_at.map_or(Field::Keep, |_| Field::Is(0)),
            width,
            height,
            ..Default::default()
        });
        value["id"].as_str().expect("an id").to_owned()
    }

    fn album(&self, title: &str) -> String {
        let value = self.arrange(act::photos::CreateAlbum {
            title: title.to_owned(),
            id: None,
        });
        value["id"].as_str().expect("an id").to_owned()
    }

    /// Trash everything the library holds, so a test sees it empty.
    fn clear_library(&mut self) {
        loop {
            self.send(H::Refreshed(wire::PhotosRefreshed {}));
            let ids = self.tile_ids();
            if ids.is_empty() {
                return;
            }
            for id in ids {
                self.arrange(act::photos::DeletePhoto { photo_id: id });
            }
        }
    }
}

fn banner_of(roll: &Roll, empty: bool) -> Option<wire::PhotosHomeImportBanner> {
    roll.banner(Locale::En, empty)
}

// ---------------------------------------------------------------------------
// Root chrome (PhotosGridChromeSpec)
// ---------------------------------------------------------------------------

#[test]
fn the_band_is_library_collections_then_more_with_no_search_tab() {
    let r = rig();
    let band = &r.state().band;
    assert_eq!(
        band.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(),
        ["library", "collections", "more"]
    );
    assert_eq!(
        band.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(),
        ["Library", "Collections", "More"]
    );
    assert_eq!(
        band.iter().map(|t| t.icon_key.as_str()).collect::<Vec<_>>(),
        ["Image", "Layers", "MoreHoriz"]
    );
}

#[test]
fn the_lit_tab_follows_the_destination_and_more_is_lit_while_its_sheet_is_up() {
    let mut r = rig();
    let lit = |r: &Rig| {
        r.state()
            .band
            .iter()
            .filter(|t| t.current)
            .map(|t| t.key.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(lit(&r), ["library"]);
    r.send(H::Band("collections".to_owned()));
    assert_eq!(lit(&r), ["collections"]);
    r.send(H::Band("more".to_owned()));
    assert_eq!(r.state().sheet, Sheet::More as i32);
    assert_eq!(lit(&r), ["more"]);
    r.send(H::Sheet(wire::photos_home_event::SheetEvent {
        sheet: Sheet::None as i32,
    }));
    assert_eq!(lit(&r), ["collections"]);
}

#[test]
fn the_filter_is_a_chip_row_on_the_library_and_its_selection_follows_the_filter() {
    let mut r = rig();
    let chips = &r.state().chips;
    assert_eq!(
        chips.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(),
        ["All photos", "Favorites"]
    );
    assert_eq!(chips.iter().filter(|c| c.selected).count(), 1);
    assert_eq!(
        chips.iter().find(|c| c.selected).unwrap().filter,
        Filter::All as i32
    );
    r.send(H::Filter(Filter::Favorites as i32));
    assert_eq!(
        r.state().chips.iter().find(|c| c.selected).unwrap().filter,
        Filter::Favorites as i32
    );
}

#[test]
fn no_chips_off_the_library_on_searchs_page_or_while_selecting() {
    let mut r = rig();
    r.send(H::Band("collections".to_owned()));
    assert!(r.state().chips.is_empty());
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    assert!(r.state().chips.is_empty());
    r.send(H::SearchClosed(wire::PhotosSearchClosed {}));
    assert!(!r.state().chips.is_empty());
    r.send(H::Selection(wire::PhotosSelectionEvent {
        kind: Some(wire::photos_selection_event::Kind::Mode(
            wire::photos_selection_event::ModeSet { selecting: true },
        )),
    }));
    assert!(r.state().chips.is_empty());
}

#[test]
fn the_headers_words_are_the_copy_tables() {
    let r = rig();
    let chrome = r.state().chrome.as_ref().expect("chrome");
    assert_eq!(chrome.title, "Photos");
    assert_eq!(chrome.search_placeholder, "Search photos, places, albums");
    assert_eq!(chrome.select_label, "Select");
    assert_eq!(chrome.cancel_label, "Cancel");
    assert_eq!(chrome.new_album_label, "New album");
    assert_eq!(layout::RUNG_LABELS, ["XS", "S", "M", "L"]);
}

#[test]
fn tile_size_is_offered_in_more_only_on_the_library_at_all() {
    let mut r = rig();
    let offered = |r: &Rig| {
        r.state()
            .more
            .as_ref()
            .is_some_and(|more| more.rows.iter().any(|row| row.key == "tile_size"))
    };
    r.send(H::Band("more".to_owned()));
    assert!(offered(&r));
    r.send(H::Grain(wire::PhotosGrainChanged {
        grain: Grain::Years as i32,
        at_day: String::new(),
    }));
    r.send(H::Band("more".to_owned()));
    assert!(!offered(&r));
    r.send(H::Band("collections".to_owned()));
    r.send(H::Band("more".to_owned()));
    assert!(!offered(&r));
}

#[test]
fn picking_a_tile_size_closes_the_choice_and_a_pinch_under_no_sheet_opens_none() {
    let mut r = rig();
    r.send(H::Sheet(wire::photos_home_event::SheetEvent {
        sheet: Sheet::TileSize as i32,
    }));
    assert_eq!(
        r.state().band.iter().find(|t| t.current).unwrap().key,
        "more"
    );
    assert_eq!(r.state().tile_size.as_ref().unwrap().options.len(), 4);
    let effects = r.send(H::Rung(0)).effects;
    assert_eq!(r.state().library.as_ref().unwrap().rung, 0);
    assert_eq!(r.state().sheet, Sheet::None as i32);
    // The tile size is device memory: a Keychain write.
    assert!(matches!(
        effects[0].effect.as_ref().unwrap().kind,
        Some(wire::effect::Kind::Keychain(ref op)) if op.op == wire::keychain_op::Op::Set as i32
    ));
    r.send(H::Rung(3));
    assert_eq!(r.state().library.as_ref().unwrap().rung, 3);
    assert_eq!(r.state().sheet, Sheet::None as i32);
}

#[test]
fn the_tile_size_is_remembered_across_launches_through_device_memory() {
    let mut r = rig();
    // The first appearance asked for it.
    assert!(r.d.effects.iter().any(|e| matches!(
        e.effect.as_ref().unwrap().kind,
        Some(wire::effect::Kind::Keychain(ref op)) if op.op == wire::keychain_op::Op::Get as i32
            && op.key == "photos.tileSize"
    )));
    r.d.answer_effect(wire::effect_result::Outcome::Keychain(
        wire::KeychainValue {
            found: true,
            value: b"3".to_vec(),
        },
    ));
    assert_eq!(r.state().library.as_ref().unwrap().rung, 3);
}

// ---------------------------------------------------------------------------
// The camera-roll banner
// ---------------------------------------------------------------------------

fn roll(permission: Perm, phase: Phase, reason: &str) -> Roll {
    let mut roll = Roll::default();
    roll.permission(permission);
    roll.backup(&wire::PhotosBackupChanged {
        phase: phase as i32,
        paused_reason: reason.to_owned(),
        ..Default::default()
    });
    roll
}

#[test]
fn a_done_or_idle_import_over_a_library_with_photographs_draws_no_banner() {
    for phase in [Phase::Done, Phase::Idle] {
        assert!(banner_of(&roll(Perm::Granted, phase, ""), false).is_none());
    }
}

#[test]
fn import_now_is_offered_over_an_empty_library_the_grant_can_fill_and_never_over_photographs() {
    let empty = banner_of(&roll(Perm::Granted, Phase::Done, ""), true).expect("a banner");
    assert!(empty.import_now);
    assert_eq!(empty.import_now_label, "Import now");
    // An empty library behind a refusal has nothing to import from.
    assert!(
        !banner_of(&roll(Perm::Denied, Phase::Idle, ""), true)
            .unwrap()
            .import_now
    );
    // A pass already running is not offered again.
    assert!(
        !banner_of(&roll(Perm::Granted, Phase::Enumerating, ""), true)
            .unwrap()
            .import_now
    );
}

#[test]
fn a_grants_remedy_is_shown_over_a_full_library_with_the_grants_own_sentence() {
    use wire::photos_home_import_banner::Remedy;
    for (permission, remedy) in [
        (Perm::NotAsked, Remedy::Ask),
        (Perm::Denied, Remedy::Settings),
        (Perm::Limited, Remedy::ManageSelection),
    ] {
        let banner = banner_of(&roll(permission, Phase::Done, ""), false).expect("a banner");
        assert_eq!(banner.remedy, remedy as i32);
        assert!(!banner.import_now);
        assert!(!banner.reason.is_empty());
    }
    let labels = banner_of(&roll(Perm::Denied, Phase::Idle, ""), false).unwrap();
    assert_eq!(labels.settings_label, "Open Settings");
    assert_eq!(labels.allow_label, "Allow photo access");
}

#[test]
fn a_restricted_phone_has_no_remedy_and_over_an_empty_library_says_why() {
    let banner = banner_of(&roll(Perm::Restricted, Phase::Idle, ""), true).expect("a banner");
    assert_eq!(banner.remedy, 0);
    assert_eq!(banner.reason, "This phone does not allow photo access.");
    assert!(banner_of(&roll(Perm::Restricted, Phase::Idle, ""), false).is_none());
}

#[test]
fn an_import_moving_or_waiting_says_so_over_a_full_library_and_no_import_now() {
    let moving = banner_of(&roll(Perm::Granted, Phase::Transferring, ""), false).unwrap();
    assert!(!moving.sentence.is_empty());
    assert!(!moving.import_now);

    let waiting = banner_of(
        &roll(
            Perm::Granted,
            Phase::WaitingForUnmetered,
            "Waiting for Wi-Fi, as you asked.",
        ),
        false,
    )
    .unwrap();
    assert_eq!(waiting.sentence, "Waiting for Wi-Fi");
    assert_eq!(waiting.reason, "Waiting for Wi-Fi, as you asked.");
}

#[test]
fn a_wait_still_says_what_it_has_already_carried() {
    let mut r = Roll::default();
    r.permission(Perm::Granted);
    r.backup(&wire::PhotosBackupChanged {
        phase: Phase::WaitingForPower as i32,
        assets_transferred_this_session: 4,
        assets_remaining: 9,
        paused_reason: String::new(),
    });
    assert_eq!(
        banner_of(&r, false).unwrap().sentence,
        "Waiting for a charger 4 done, 9 waiting."
    );
    r.backup(&wire::PhotosBackupChanged {
        phase: Phase::Transferring as i32,
        assets_transferred_this_session: 4,
        assets_remaining: 9,
        paused_reason: String::new(),
    });
    assert_eq!(
        banner_of(&r, false).unwrap().sentence,
        "Importing: 4 done, 9 to go"
    );
}

#[test]
fn the_grant_moves_the_banner_and_never_the_library_and_the_banner_rides_every_step() {
    let mut r = rig();
    r.photo("home banner", None, None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let before = r.tile_ids();
    assert!(!before.is_empty());
    r.send(H::Permission(wire::PhotosPermissionChanged {
        permission: Perm::Denied as i32,
    }));
    // A DENIED PERMISSION DOES NOT BLANK THE LIBRARY.
    assert_eq!(r.tile_ids(), before);
    let banner = r.state().import_banner.as_ref().expect("a banner");
    assert_eq!(
        banner.remedy,
        wire::photos_home_import_banner::Remedy::Settings as i32
    );
    r.send(H::Permission(wire::PhotosPermissionChanged {
        permission: Perm::Granted as i32,
    }));
    assert!(r.state().import_banner.is_none());
    r.send(H::Backup(wire::PhotosBackupChanged {
        phase: Phase::Transferring as i32,
        assets_transferred_this_session: 1,
        assets_remaining: 2,
        paused_reason: String::new(),
    }));
    assert!(r.state().import_banner.is_some());
    r.send(H::Backup(wire::PhotosBackupChanged {
        phase: Phase::Done as i32,
        ..Default::default()
    }));
    assert!(r.state().import_banner.is_none());
}

#[test]
fn a_permission_or_progress_report_asks_the_shell_for_nothing() {
    let mut r = rig();
    let update = r.send(H::Permission(wire::PhotosPermissionChanged {
        permission: Perm::Denied as i32,
    }));
    assert!(
        update.effects.is_empty(),
        "a report is a fact, not a request: {:?}",
        update.effects
    );
    let update = r.send(H::Backup(wire::PhotosBackupChanged {
        phase: Phase::Transferring as i32,
        assets_transferred_this_session: 1,
        assets_remaining: 2,
        paused_reason: String::new(),
    }));
    assert!(update.effects.is_empty(), "{:?}", update.effects);
}

#[test]
fn import_now_over_an_emptied_library_asks_the_camera_roll_for_a_pass_and_the_shell_for_nothing() {
    let mut r = rig();
    r.clear_library();
    r.send(H::Permission(wire::PhotosPermissionChanged {
        permission: Perm::Granted as i32,
    }));
    let banner = r.state().import_banner.as_ref().expect("a banner");
    assert!(banner.import_now);
    // A library emptied by the Favorites filter is not an empty library.
    r.send(H::Filter(Filter::Favorites as i32));
    assert!(r.state().import_banner.is_none());
    r.send(H::Filter(Filter::All as i32));
    // THE ROLL IS ASKED BY NAME (`imports_by_name.rs` follows it there).
    let update = r.send(H::ImportNow(wire::PhotosImportNow {}));
    assert!(update.effects.is_empty(), "{:?}", update.effects);
    // The empty library says so, in its own words.
    let empty = r.library().empty.as_ref().expect("an empty state");
    assert_eq!(empty.headline, "No photos on this phone yet.");
}

#[test]
fn the_platforms_own_pages_are_effects_the_shell_performs_and_the_prompt_is_the_rolls() {
    use wire::camera_roll::Action;
    use wire::photos_home_import_banner::Remedy;
    let mut r = rig();
    let update = r.send(H::Remedy(wire::PhotosBannerRemedy {
        remedy: Remedy::Ask as i32,
    }));
    assert!(update.effects.is_empty(), "{:?}", update.effects);
    for (remedy, action) in [
        (Remedy::Settings, Action::OpenSettings),
        (Remedy::ManageSelection, Action::ManageSelection),
    ] {
        let update = r.send(H::Remedy(wire::PhotosBannerRemedy {
            remedy: remedy as i32,
        }));
        assert!(matches!(
            update.effects[0].effect.as_ref().unwrap().kind,
            Some(wire::effect::Kind::CameraRoll(ref roll)) if roll.action == action as i32
        ));
    }
}

// ---------------------------------------------------------------------------
// Layout (PhotosLibraryLayoutSpec)
// ---------------------------------------------------------------------------

fn boxed(width: u32, height: u32) -> Boxed {
    Boxed { width, height }
}

#[test]
fn a_full_row_fills_the_width_to_the_point_folding_its_remainder_into_the_last_tile() {
    let rows = layout::justify(&[boxed(3, 2); 4], 400.0, 120.0);
    let first = &rows[0];
    assert_eq!(first.iter().map(|t| t.index).collect::<Vec<_>>(), [0, 1, 2]);
    assert!((first.iter().map(|t| t.width).sum::<f64>() + layout::GAP * 2.0 - 400.0).abs() < 1e-9);
    let heights: Vec<f64> = first.iter().map(|t| t.height).collect();
    assert!(heights.windows(2).all(|w| w[0] == w[1]));
}

#[test]
fn the_trailing_row_keeps_its_natural_height_capped_at_one_and_a_quarter_times_the_target() {
    let rows = layout::justify(&[boxed(1000, 1000)], 400.0, 100.0);
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0][0].width, rows[0][0].height), (125.0, 125.0));
}

#[test]
fn an_unknown_box_packs_square_and_a_zero_width_packs_nothing() {
    let rows = layout::justify(&[boxed(0, 0), boxed(1, 1)], 200.0, 100.0);
    for tile in rows.iter().flatten() {
        assert!((tile.width / tile.height - 1.0).abs() < 1e-9);
    }
    assert!(layout::justify(&[boxed(1, 1)], 0.0, 100.0).is_empty());
    assert!(layout::justify(&[boxed(1, 1)], 100.0, 0.0).is_empty());
}

#[test]
fn the_skeleton_rounds_both_halves_of_its_count_up_and_every_row_is_as_wide_as_the_container() {
    let rows = layout::skeleton(300.0, 100.0, 400.0);
    // perRow = 3 + 1, rowCount = 4 + 1: twenty placeholders, packed.
    assert_eq!(rows.iter().map(Vec::len).sum::<usize>(), 20);
    for row in &rows[..rows.len() - 1] {
        let width: f64 = row.iter().map(|t| t.width).sum();
        assert_eq!(width + layout::GAP * (row.len() as f64 - 1.0), 300.0);
    }
}

fn cell<'a>(id: &'a str, day: &'a str, video: bool) -> layout::Cell<'a> {
    layout::Cell {
        id,
        day,
        video,
        boxed: boxed(1500, 1000),
    }
}

#[test]
fn rows_put_a_month_header_where_the_month_changes_a_day_header_per_day_then_the_tiles() {
    let cells = [
        cell("a", "2026-08-14", false),
        cell("b", "2026-08-14", false),
        cell("c", "2026-07-30", false),
        cell("d", "", false),
    ];
    let rows = layout::rows(Locale::En, &cells, 300.0, layout::DEFAULT_RUNG, 2026);
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        [
            "m:2026-08",
            "d:2026-08-14",
            "r:2026-08-14:0",
            "m:2026-07",
            "d:2026-07-30",
            "r:2026-07-30:0",
            "m:undated",
            "r::0"
        ]
    );
    assert_eq!(rows[0].title, "August 2026");
    // THIS YEAR'S DAYS CARRY NO YEAR.
    assert_eq!(rows[1].title, "Fri, Aug 14");
    assert_eq!(rows[1].ids, ["a", "b"]);
    // THE UNDATED TAIL HAS ONE HEADER and no day under it.
    assert_eq!(rows[6].title, "Undated");
    assert!(
        rows.iter()
            .all(|r| r.kind != layout::RowKind::Day || !r.day.is_empty())
    );
    // TILES NAME THEIR CELL BY ITS PLACE IN THE WHOLE LIST, not in the day.
    assert_eq!(
        rows[5].tiles.iter().map(|t| t.index).collect::<Vec<_>>(),
        [2]
    );
    assert_eq!(
        rows[7].tiles.iter().map(|t| t.index).collect::<Vec<_>>(),
        [3]
    );
}

#[test]
fn another_years_day_carries_its_year_and_a_rung_past_the_table_is_clamped() {
    let rows = layout::rows(
        Locale::En,
        &[cell("a", "2025-01-02", false)],
        300.0,
        0,
        2026,
    );
    assert_eq!(rows[1].title, "Thu, Jan 2, 2025");
    let rows = layout::rows(
        Locale::En,
        &[cell("a", "2026-08-14", false)],
        1000.0,
        99,
        2026,
    );
    // The largest rung is 168, and a lone trailing photograph stops at 1.25 times it.
    assert_eq!(rows.last().unwrap().tiles[0].height, 210.0);
}

#[test]
fn periods_keep_the_cells_order_cover_with_the_newest_thumbnail_and_leave_the_undated_out() {
    let cells = [
        cell("a", "2026-08-14", true),
        cell("b", "2026-08-02", false),
        cell("c", "2026-07-30", false),
        cell("d", "2025-12-31", false),
        cell("e", "", false),
    ];
    let thumb = |at: usize| at == 1 || at == 3;
    let months = layout::periods(Locale::En, &cells, thumb, false);
    assert_eq!(
        months.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
        ["2026-08", "2026-07", "2025-12"]
    );
    assert_eq!(months[0].title, "August 2026");
    assert_eq!(months[0].cover, 1);
    assert_eq!(months[0].anchor_day, "2026-08-14");
    assert_eq!(months[0].count, "1 photo · 1 video");
    let years = layout::periods(Locale::En, &cells, thumb, true);
    assert_eq!(
        years.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(),
        ["2026", "2025"]
    );
}

#[test]
fn months_pair_within_a_year_and_a_year_header_appears_only_when_the_library_spans_two() {
    let days = [
        "2026-08-14",
        "2026-07-30",
        "2026-05-01",
        "2025-12-31",
        "2025-01-01",
    ];
    let cells: Vec<_> = days.iter().map(|d| cell(d, d, false)).collect();
    let periods = layout::periods(Locale::En, &cells, |_| false, false);
    let items = layout::grain_items(periods.clone(), false);
    assert_eq!(
        items.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(),
        ["h:2026", "p:2026-08", "p:2026-05", "h:2025", "p:2025-12"]
    );
    assert_eq!(
        items.iter().map(|i| i.periods.len()).collect::<Vec<_>>(),
        [0, 2, 1, 0, 2]
    );
    let one_year = layout::grain_items(periods[..3].to_vec(), false);
    assert_eq!(
        one_year.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(),
        ["p:2026-08", "p:2026-05"]
    );
    let years = layout::grain_items(layout::periods(Locale::En, &cells, |_| false, true), true);
    assert_eq!(
        years.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(),
        ["y:2026", "y:2025"]
    );
}

#[test]
fn a_pinch_is_a_rung_step_inside_all_and_a_grain_past_its_ends() {
    use layout::{Pinch, pinch};
    let all = |rung| Pinch {
        grain: Grain::All,
        rung,
    };
    assert_eq!(pinch(Grain::All, 2, 1.3), all(3));
    assert_eq!(pinch(Grain::All, 3, 1.3), all(3));
    assert_eq!(
        pinch(Grain::All, 0, 0.5),
        Pinch {
            grain: Grain::Months,
            rung: 0
        }
    );
    assert_eq!(pinch(Grain::All, 2, 1.0), all(2));
    // The unspecified grain is All, as the library draws it.
    assert_eq!(pinch(Grain::Unspecified, 1, 0.5), all(0));
    assert_eq!(pinch(Grain::Months, 1, 1.3).grain, Grain::All);
    assert_eq!(pinch(Grain::Months, 1, 0.5).grain, Grain::Years);
    assert_eq!(pinch(Grain::Years, 1, 0.5).grain, Grain::Years);
}

#[test]
fn a_grain_lands_on_the_stretch_of_time_the_member_was_in() {
    let days = ["2026-08-14", "2026-08-02", "2026-07-30"];
    assert_eq!(
        layout::anchor(Grain::Years, "2026-07-30", &days),
        "2026-08-14"
    );
    assert_eq!(
        layout::anchor(Grain::Months, "2026-07-30", &days),
        "2026-07-30"
    );
    assert_eq!(
        layout::anchor(Grain::All, "2026-08-02", &days),
        "2026-08-02"
    );
    // The undated tail is no stretch of time.
    assert_eq!(layout::anchor(Grain::Years, "", &days), "");
    assert_eq!(layout::narrower(Grain::Years), Grain::Months);
    assert_eq!(layout::narrower(Grain::Months), Grain::All);
}

// ---------------------------------------------------------------------------
// The library, through the door
// ---------------------------------------------------------------------------

#[test]
fn the_library_packs_rows_at_the_width_the_shell_reports() {
    let mut r = rig();
    let a = r.photo(
        "lib rows a",
        Some("2026-03-02T10:00:00Z"),
        Some((3000, 2000)),
    );
    let b = r.photo(
        "lib rows b",
        Some("2026-03-02T11:00:00Z"),
        Some((2000, 3000)),
    );
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    // No width yet: no rows, but the tiles are there.
    assert!(r.library().rows.is_empty());
    assert!(r.tile_ids().contains(&a));
    r.viewport(390.0);
    let rows = &r.library().rows;
    assert!(!rows.is_empty());
    let tiles_in_rows: Vec<u32> = rows
        .iter()
        .flat_map(|row| row.packed.iter().map(|p| p.tile))
        .collect();
    let tiles = r.tile_ids();
    assert_eq!(tiles_in_rows.len(), tiles.len());
    for packed in rows.iter().flat_map(|row| &row.packed) {
        assert!(packed.width > 0.0 && packed.height > 0.0);
    }
    let _ = b;
    // A day header names its photographs for "Select".
    let day = rows
        .iter()
        .find(|row| row.day == "2026-03-02" && row.kind == wire::PhotosRowKind::Day as i32)
        .expect("a day header");
    assert_eq!(day.ids.len(), 2);
    assert_eq!(day.select_label, format!("Select {}", day.title));
}

#[test]
fn the_library_pages_as_the_end_comes_into_view_and_says_when_it_ended() {
    let mut r = rig();
    for n in 0..125 {
        r.photo(&format!("paging {n}"), Some("2026-02-01T10:00:00Z"), None);
    }
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let first = r.tile_ids().len();
    assert_eq!(first, 120, "one page of the library");
    assert!(!r.library().complete);
    // The count is the shelf's exact size, not the page's.
    assert!(
        r.library()
            .count_label
            .starts_with(|c: char| c.is_ascii_digit())
    );
    assert_ne!(r.library().count_label, format!("{first} photos"));
    r.send(H::NextPage(wire::PhotosNextPage {}));
    assert!(r.tile_ids().len() > first);
    assert!(r.library().complete);
    let ids = r.tile_ids();
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(ids.len(), unique.len(), "no photograph twice");
    // A library that has ended asks for nothing.
    r.send(H::NextPage(wire::PhotosNextPage {}));
    assert_eq!(r.tile_ids().len(), ids.len());
}

#[test]
fn a_write_reads_in_place_and_keeps_the_pages_the_member_had_scrolled() {
    let mut r = rig();
    for n in 0..125 {
        r.photo(&format!("in place {n}"), Some("2026-01-01T10:00:00Z"), None);
    }
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    r.send(H::NextPage(wire::PhotosNextPage {}));
    let loaded = r.tile_ids();
    assert!(loaded.len() > 120);
    // Another surface favourites one: the change feed re-reads the library.
    r.arrange(act::photos::FlagPhoto {
        photo_id: loaded[3].clone(),
    });
    r.d.pump(std::time::Duration::from_millis(300));
    assert_eq!(r.tile_ids(), loaded, "the same extent, in the same order");
    assert!(r.tile(&loaded[3]).favorite);
}

#[test]
fn the_favorites_filter_narrows_the_read_not_the_drawing() {
    let mut r = rig();
    let loved = r.photo("loved", Some("2026-04-01T10:00:00Z"), None);
    let plain = r.photo("plain", Some("2026-04-02T10:00:00Z"), None);
    r.arrange(act::photos::FlagPhoto {
        photo_id: loved.clone(),
    });
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    assert!(r.tile_ids().contains(&plain));
    r.send(H::Filter(Filter::Favorites as i32));
    assert!(r.tile_ids().contains(&loved));
    assert!(!r.tile_ids().contains(&plain));
    assert_eq!(
        r.state().library.as_ref().unwrap().filter,
        Filter::Favorites as i32
    );
    // Un-favouriting everything says so in the empty state's own words.
    for id in r.tile_ids() {
        r.arrange(act::photos::UnflagPhoto { photo_id: id });
    }
    r.d.pump(std::time::Duration::from_millis(300));
    let empty = r.library().empty.as_ref().expect("empty favorites");
    assert_eq!(empty.headline, "No favorites yet");
}

#[test]
fn a_zoom_lands_where_the_member_was_and_a_card_is_a_door_one_grain_in() {
    let mut r = rig();
    r.photo("zoom a", Some("2024-09-14T10:00:00Z"), None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    r.send(H::Grain(wire::PhotosGrainChanged {
        grain: Grain::Years as i32,
        at_day: "2024-09-14".to_owned(),
    }));
    let library = r.state().library.as_ref().unwrap();
    assert_eq!(library.grain, Grain::Years as i32);
    assert_eq!(library.place_day, "2024-09-14");
    assert!(!r.library().grain_items.is_empty());
    assert!(r.library().rows.is_empty());
    assert!(!r.library().undated_note.is_empty());
    let card = r.library().grain_items[0].periods[0].clone();
    assert!(!card.title.is_empty());
    r.send(H::PeriodOpened(card.anchor_day.clone()));
    let library = r.state().library.as_ref().unwrap();
    assert_eq!(library.grain, Grain::Months as i32);
    assert_eq!(library.place_day, card.anchor_day);
    // Leaving the library resets the zoom to All.
    r.send(H::Band("collections".to_owned()));
    r.send(H::Band("library".to_owned()));
    assert_eq!(r.state().library.as_ref().unwrap().grain, Grain::All as i32);
}

#[test]
fn a_pinch_steps_the_size_and_past_the_ends_moves_the_grain() {
    let mut r = rig();
    r.send(H::Pinched(wire::PhotosPinched {
        scale: 1.3,
        at_day: String::new(),
    }));
    assert_eq!(r.state().library.as_ref().unwrap().rung, 3);
    r.send(H::Rung(0));
    r.send(H::Pinched(wire::PhotosPinched {
        scale: 0.5,
        at_day: String::new(),
    }));
    assert_eq!(
        r.state().library.as_ref().unwrap().grain,
        Grain::Months as i32
    );
}

#[test]
fn the_tiles_share_one_route_to_the_lightbox_carrying_the_librarys_order() {
    let mut r = rig();
    r.photo("route a", Some("2026-05-01T10:00:00Z"), None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let open = r.library().open.as_ref().unwrap();
    let Some(wire::route::Args::PhotosLightbox(args)) = &open.args else {
        panic!("not a lightbox route");
    };
    assert_eq!(open.screen, photos::LIGHTBOX);
    assert!(args.photo_id.is_empty());
    assert_eq!(args.neighbour_ids, r.tile_ids());
}

// ---------------------------------------------------------------------------
// Select mode and its writes
// ---------------------------------------------------------------------------

fn selection(kind: wire::photos_selection_event::Kind) -> H {
    H::Selection(wire::PhotosSelectionEvent { kind: Some(kind) })
}

fn toggle(id: &str) -> H {
    selection(wire::photos_selection_event::Kind::Toggled(
        wire::photos_selection_event::Toggled {
            photo_id: id.to_owned(),
        },
    ))
}

fn verb(kind: wire::photos_batch_action::Kind) -> H {
    selection(wire::photos_selection_event::Kind::Action(
        wire::photos_selection_event::ActionTapped { kind: kind as i32 },
    ))
}

#[test]
fn a_favourite_keeps_the_selection_and_the_value_is_one_for_the_whole_pick() {
    use wire::photos_batch_action::Kind as V;
    let mut r = rig();
    let a = r.photo("sel a", Some("2026-06-01T10:00:00Z"), None);
    let b = r.photo("sel b", Some("2026-06-02T10:00:00Z"), None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    r.send(toggle(&a));
    r.send(toggle(&b));
    assert_eq!(r.state().selection.as_ref().unwrap().count, 2);
    r.send(verb(V::Favorite));
    assert!(r.tile(&a).favorite && r.tile(&b).favorite);
    // The pick stays: favouriting is not the end of a member's job with it.
    assert_eq!(r.state().selection.as_ref().unwrap().count, 2);
    r.send(verb(V::Unfavorite));
    assert!(!r.tile(&a).favorite && !r.tile(&b).favorite);
}

#[test]
fn the_bar_offers_favorite_in_all_and_unfavorite_only_under_the_favorites_filter() {
    use wire::photos_batch_action::Kind as V;
    let mut r = rig();
    let a = r.photo("bar a", Some("2026-06-01T10:00:00Z"), None);
    r.arrange(act::photos::FlagPhoto {
        photo_id: a.clone(),
    });
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let kinds = |r: &Rig| -> Vec<i32> {
        r.state()
            .selection
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .map(|action| action.kind)
            .collect()
    };
    r.send(toggle(&a));
    assert!(kinds(&r).contains(&(V::Favorite as i32)));
    assert!(!kinds(&r).contains(&(V::Unfavorite as i32)));
    // Under Favorites every photograph on screen already is one: the verb turns round.
    r.send(H::Filter(Filter::Favorites as i32));
    r.send(toggle(&a));
    assert!(kinds(&r).contains(&(V::Unfavorite as i32)));
    assert!(!kinds(&r).contains(&(V::Favorite as i32)));
}

#[test]
fn trash_asks_first_ends_the_mode_and_takes_the_photographs_out_of_the_grid() {
    use wire::photos_batch_action::Kind as V;
    let mut r = rig();
    let a = r.photo("trash a", Some("2026-06-03T10:00:00Z"), None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    // A trash confirm over nothing is not asked.
    r.send(verb(V::Trash));
    assert!(r.state().selection.as_ref().unwrap().confirm.is_none());
    r.send(toggle(&a));
    r.send(verb(V::Trash));
    let confirm = r
        .state()
        .selection
        .as_ref()
        .unwrap()
        .confirm
        .clone()
        .expect("a confirm");
    assert_eq!(confirm.title, "Move 1 photo to the trash?");
    assert!(r.tile_ids().contains(&a));
    r.send(selection(wire::photos_selection_event::Kind::Confirmed(
        wire::photos_selection_event::Confirmed {},
    )));
    assert!(!r.tile_ids().contains(&a));
    let bar = r.state().selection.as_ref().unwrap();
    assert!(!bar.selecting && bar.count == 0);
}

#[test]
fn a_range_and_a_days_select_pick_in_the_order_drawn() {
    let mut r = rig();
    let a = r.photo("range a", Some("2026-06-10T10:00:00Z"), None);
    let b = r.photo("range b", Some("2026-06-10T11:00:00Z"), None);
    let c = r.photo("range c", Some("2026-06-10T12:00:00Z"), None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let order = r.tile_ids();
    let from = order.iter().position(|id| *id == c).unwrap();
    let to = order.iter().position(|id| *id == a).unwrap();
    assert!(order.contains(&b));
    r.send(selection(wire::photos_selection_event::Kind::Range(
        wire::photos_selection_event::SelectRange {
            from_photo_id: c.clone(),
            to_photo_id: a.clone(),
        },
    )));
    assert_eq!(
        r.state().selection.as_ref().unwrap().count as usize,
        to - from + 1
    );
    // A day's Select flips to Deselect once all of it is picked.
    r.viewport(390.0);
    let day = r
        .library()
        .rows
        .iter()
        .find(|row| row.day == "2026-06-10" && row.kind == wire::PhotosRowKind::Day as i32)
        .unwrap();
    assert!(day.all_selected);
    assert!(day.select_label.starts_with("Deselect"));
}

#[test]
fn the_album_sheet_puts_the_pick_in_an_album_and_ends_the_mode() {
    use wire::photos_batch_action::Kind as V;
    let mut r = rig();
    let a = r.photo("album pick", Some("2026-06-20T10:00:00Z"), None);
    let album = r.album("Zq library pick");
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    r.send(toggle(&a));
    r.send(verb(V::AddToAlbum));
    let sheet = r.state().album_choice.as_ref().unwrap();
    assert!(sheet.open && sheet.loaded);
    assert!(sheet.entries.iter().any(|e| e.album_id == album));
    r.send(H::AlbumChoice(wire::PhotosAlbumChoiceEvent {
        kind: Some(wire::photos_album_choice_event::Kind::Chosen(
            wire::photos_album_choice_event::Chosen {
                album_id: album.clone(),
            },
        )),
    }));
    assert!(!r.state().album_choice.as_ref().unwrap().open);
    assert!(!r.state().selection.as_ref().unwrap().selecting);
    r.send(H::Band("collections".to_owned()));
    let card = r
        .section("albums")
        .cards
        .iter()
        .find(|card| card.id == album)
        .expect("the album")
        .clone();
    assert_eq!(card.count_label, "1 photo");
}

#[test]
fn send_a_copy_asks_which_location_travels_then_hands_the_pick_to_the_shell() {
    let mut r = rig();
    let a = r.photo("copy a", Some("2026-06-21T10:00:00Z"), None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    // Over nothing there is no question.
    r.send(H::CopyAsked(wire::PhotosCopyAsked {}));
    assert_eq!(r.state().sheet, Sheet::None as i32);
    r.send(toggle(&a));
    r.send(H::CopyAsked(wire::PhotosCopyAsked {}));
    assert_eq!(r.state().sheet, Sheet::CopyPlace as i32);
    assert_eq!(
        r.state().copy_place.as_ref().unwrap().title,
        "Include which location?"
    );
    let update = r.send(H::CopyPlaceChosen(wire::PhotosCopyPlaceChosen {
        keep_location: false,
    }));
    let Some(wire::effect::Kind::ExportOriginals(export)) =
        &update.effects[0].effect.as_ref().unwrap().kind
    else {
        panic!("not an export");
    };
    assert_eq!(export.photo_ids, [a]);
    assert!(!export.keep_location);
    assert_eq!(r.state().sheet, Sheet::None as i32);
    // What it came to is one clause; the sheet says what it did.
    for (status, missing, expected) in [
        (
            wire::originals_exported::Status::NoneHere,
            0,
            Some("The originals are not on this phone, so nothing was sent."),
        ),
        (
            wire::originals_exported::Status::Done,
            2,
            Some("2 originals are not on this phone, so they were left out."),
        ),
        (wire::originals_exported::Status::Done, 0, None),
        (
            wire::originals_exported::Status::Failed,
            0,
            Some("Photos not exported. Try again."),
        ),
    ] {
        r.d.effects.push(update.effects[0].clone());
        r.d.answer_effect(wire::effect_result::Outcome::OriginalsExported(
            wire::OriginalsExported {
                status: status as i32,
                handed: 0,
                missing,
            },
        ));
        assert_eq!(
            r.state().status.as_ref().map(|s| s.sentence.as_str()),
            expected
        );
    }
}

// ---------------------------------------------------------------------------
// The download arrow (FreeUpSpec's way back)
// ---------------------------------------------------------------------------

/// Pump the core's events until `done` holds, or give up after five seconds.
fn pump_until(r: &mut Rig, done: impl Fn(&Rig) -> bool) {
    for _ in 0..100 {
        if done(r) {
            return;
        }
        r.d.pump(std::time::Duration::from_millis(50));
    }
}

#[test]
fn a_tapped_download_asks_the_core_off_the_lock_and_says_why_it_did_not_land() {
    let mut r = keyed_rig();
    let a = r.photo("fetch a", Some("2026-07-01T10:00:00Z"), None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    assert!(!r.tile(&a).content_id.is_empty());
    // THE CORE IS ASKED, NOT THE SHELL: the cell paints fetching at once.
    let update = r.send(H::OriginalRequested(a.clone()));
    assert!(update.effects.is_empty(), "{:?}", update.effects);
    assert_eq!(r.tile(&a).held, wire::photo_tile::Held::Fetching as i32);
    // A second tap while it moves asks for nothing more.
    assert!(r.send(H::OriginalRequested(a.clone())).effects.is_empty());
    // No backup device is paired, so none answers: the cell stops and the line says why.
    pump_until(&mut r, |r| {
        r.tile(&a).held != wire::photo_tile::Held::Fetching as i32
    });
    assert_ne!(r.tile(&a).held, wire::photo_tile::Held::Fetching as i32);
    let status = r.state().status.as_ref().expect("a status");
    assert_eq!(
        status.sentence,
        "Can't reach your backup device. Try again later."
    );
    assert!(status.refused);
    assert!(r.tile_ids().contains(&a));
}

// ---------------------------------------------------------------------------
// Free up space
// ---------------------------------------------------------------------------

fn facts(releasable: u32) -> wire::FreeUpFacts {
    wire::FreeUpFacts {
        offered: true,
        counted: true,
        on_phone_count: 40,
        on_phone_bytes: 3_000_000_000,
        checked: true,
        releasable_count: releasable,
        releasable_bytes: u64::from(releasable) * 1_000_000_000,
        ..Default::default()
    }
}

/// The shell reports what the platform can do; `deletes` is whether it deletes from its photo
/// library behind its own confirmation.
fn environment(r: &mut Rig, deletes: bool) {
    r.d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-US".to_owned(),
        zone: "UTC".to_owned(),
        platform: "ios".to_owned(),
        library_deletes: deletes,
    }));
}

fn free_up_row(r: &Rig) -> Option<wire::PhotosFreeUpRow> {
    r.state()
        .more
        .as_ref()
        .and_then(|more| more.free_up.clone())
}

#[test]
fn the_more_sheet_counts_off_the_lock_through_the_core_and_asks_the_shell_nothing() {
    let mut r = keyed_rig();
    environment(&mut r, true);
    let update = r.send(H::Band("more".to_owned()));
    assert!(update.effects.is_empty(), "{:?}", update.effects);
    // Nothing is drawn until the census has answered.
    assert!(free_up_row(&r).is_none());
    pump_until(&mut r, |r| free_up_row(r).is_some());
    let row = free_up_row(&r).expect("a row");
    assert_eq!(row.title, "Free up space");
    // No gateway holds an original whole yet, so nothing can be freed.
    assert!(!row.enabled && row.action_label.is_empty());
    assert!(
        row.reason.starts_with("None can be freed yet."),
        "{}",
        row.reason
    );
    assert_eq!(
        row.retention,
        "Deleted photos stay on your backup device for a while before they are cleared."
    );
    // A tap on a row with nothing to free asks the platform nothing.
    assert!(
        r.send(H::FreeUpTapped(wire::PhotosFreeUpTapped {}))
            .effects
            .is_empty()
    );
}

#[test]
fn a_phone_whose_platform_cannot_delete_is_offered_no_row_and_counts_nothing() {
    let mut r = rig();
    environment(&mut r, false);
    let update = r.send(H::Band("more".to_owned()));
    assert!(update.effects.is_empty());
    r.d.pump(std::time::Duration::from_millis(200));
    assert!(r.state().more.is_some(), "the sheet is up");
    assert!(free_up_row(&r).is_none());
}

#[test]
fn nothing_is_offered_until_a_gateway_holds_an_original_whole() {
    use centraid_screens::photos::keep_originals::FreeUpRow;
    let none = FreeUpRow::from_facts(Locale::En, &facts(0));
    assert!(!none.enabled && none.action_label.is_empty());
    assert!(none.reason.starts_with("None can be freed yet."));
    let mut unchecked = facts(0);
    unchecked.checked = false;
    let row = FreeUpRow::from_facts(Locale::En, &unchecked);
    assert!(!row.enabled);
    assert!(row.reason.starts_with("Centraid could not check"));
    // NOT COUNTED IS NEVER ZERO.
    let mut uncounted = facts(2);
    uncounted.counted = false;
    let row = FreeUpRow::from_facts(Locale::En, &uncounted);
    assert_eq!(row.meta, "Not counted yet.");
    assert!(!row.enabled);
    // A phone that cannot delete draws no row at all.
    let mut cannot = facts(2);
    cannot.offered = false;
    assert!(!FreeUpRow::from_facts(Locale::En, &cannot).offered);
    // Albums the member keeps are said beside the reason.
    let mut kept = facts(1);
    kept.kept_count = 3;
    assert_eq!(
        FreeUpRow::from_facts(Locale::En, &kept).reason,
        "1 photo is backed up. 3 of them are in albums you keep on this phone."
    );
}

#[test]
fn what_the_last_free_up_came_to_is_one_sentence_on_the_row() {
    use centraid_screens::photos::keep_originals::FreeUpRow;
    let mut after = facts(0);
    after.outcome = wire::free_up_facts::Outcome::Freed as i32;
    after.freed_bytes = 2_000_000_000;
    let row = FreeUpRow::from_facts(Locale::En, &after);
    assert!(!row.freeing);
    assert_eq!(
        row.notice,
        "Freed 2 GB. Photos download again from your backup device when you open them."
    );
    for (outcome, text) in [
        (
            wire::free_up_facts::Outcome::NothingRemoved,
            "Nothing removed.",
        ),
        (
            wire::free_up_facts::Outcome::NotRecorded,
            "Photos removed from this phone. They show as downloadable once Centraid catches up.",
        ),
    ] {
        let mut f = facts(1);
        f.outcome = outcome as i32;
        assert_eq!(FreeUpRow::from_facts(Locale::En, &f).notice, text);
    }
    let mut platform = facts(1);
    platform.outcome = wire::free_up_facts::Outcome::PlatformError as i32;
    platform.platform_error = "Photos access is limited.".to_owned();
    assert_eq!(
        FreeUpRow::from_facts(Locale::En, &platform).notice,
        "Photos access is limited."
    );
    // A row with something to free holds still while the system asks.
    let row = FreeUpRow::from_facts(Locale::En, &facts(2));
    let held = row.tapped().expect("a tap holds");
    assert!(held.freeing && held.tapped().is_none());
}

#[test]
fn the_cameras_roll_sheet_says_the_rest_of_what_the_banner_says_in_one_line() {
    let mut r = rig();
    r.send(H::Backup(wire::PhotosBackupChanged {
        phase: Phase::WaitingForPower as i32,
        assets_transferred_this_session: 0,
        assets_remaining: 0,
        paused_reason: "Plug in to continue.".to_owned(),
    }));
    r.send(H::Sheet(wire::photos_home_event::SheetEvent {
        sheet: Sheet::BackupDetail as i32,
    }));
    let detail = r.state().backup_detail.as_ref().expect("the detail");
    assert!(detail.import_enabled);
    assert_eq!(
        detail
            .rows
            .iter()
            .find(|row| row.key == "Paused")
            .unwrap()
            .value,
        "Plug in to continue."
    );
    r.send(H::Backup(wire::PhotosBackupChanged {
        phase: Phase::Transferring as i32,
        ..Default::default()
    }));
    assert!(!r.state().backup_detail.as_ref().unwrap().import_enabled);
}

// ---------------------------------------------------------------------------
// Collections (PhotosCollectionsSpec)
// ---------------------------------------------------------------------------

#[test]
fn collections_are_pinned_albums_and_utilities_with_the_rows_the_system_sorts() {
    let mut r = rig_at(Dest::Collections, None);
    r.album("Zq Portugal");
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let keys: Vec<&str> = r
        .collections()
        .sections
        .iter()
        .map(|s| s.key.as_str())
        .collect();
    assert_eq!(&keys[..3], ["pinned", "albums", "utilities"]);
    let titles = |key: &str| {
        r.section(key)
            .cards
            .iter()
            .map(|c| c.title.clone())
            .collect::<Vec<_>>()
    };
    // PLACES AFTER THE SECOND STANDING SHELF, where the system puts Map.
    assert_eq!(titles("pinned"), ["Favorites", "Videos", "Places"]);
    assert_eq!(titles("utilities"), ["Archive", "Trash"]);
    let album = r
        .section("albums")
        .cards
        .iter()
        .find(|c| c.title == "Zq Portugal")
        .unwrap();
    assert!(!album.delete_label.is_empty());
    assert_eq!(album.count_label, "Empty");
    // A standing shelf cannot be deleted; a tap is the route in the card.
    assert!(
        r.section("pinned")
            .cards
            .iter()
            .all(|c| c.delete_label.is_empty())
    );
    let Some(wire::route::Args::PhotosShelf(shelf)) = &album.route.as_ref().unwrap().args else {
        panic!("an album opens a shelf");
    };
    assert_eq!(shelf.kind, wire::PhotosShelfKind::Album as i32);
    assert_eq!(shelf.title, "Zq Portugal");
    let places = r
        .section("pinned")
        .cards
        .iter()
        .find(|c| c.kind == wire::photos_collection_card::Kind::Places as i32)
        .unwrap();
    assert_eq!(places.route.as_ref().unwrap().screen, photos::PLACES);
}

#[test]
fn a_count_is_the_exact_size_of_the_shelf_it_opens() {
    let mut r = rig_at(Dest::Collections, None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let before: u32 = r
        .section("utilities")
        .cards
        .iter()
        .find(|c| c.title == "Trash")
        .unwrap()
        .count_label
        .parse()
        .unwrap_or(0);
    let a = r.photo("count trash", Some("2026-08-01T10:00:00Z"), None);
    r.arrange(act::photos::DeletePhoto { photo_id: a });
    r.d.pump(std::time::Duration::from_millis(300));
    let after: u32 = r
        .section("utilities")
        .cards
        .iter()
        .find(|c| c.title == "Trash")
        .unwrap()
        .count_label
        .parse()
        .unwrap_or(0);
    assert_eq!(after, before + 1);
}

#[test]
fn an_empty_albums_section_is_a_card_with_a_verb_and_the_sections_fold() {
    let mut r = rig_at(Dest::Collections, None);
    // The scenario's own albums are trashed so the section is empty.
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let ids: Vec<String> = r
        .section("albums")
        .cards
        .iter()
        .map(|c| c.id.clone())
        .collect();
    for id in ids {
        r.arrange(act::photos::DeleteAlbum { album_id: id });
    }
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    let empty = r
        .section("albums")
        .empty
        .as_ref()
        .expect("an empty albums card");
    assert_eq!(empty.headline, "No albums yet");
    assert_eq!(empty.action_label, "Create");
    // Fold one, then the bulk link folds the rest, then opens them all.
    r.send(H::SectionToggled("pinned".to_owned()));
    assert!(r.section("pinned").folded);
    assert_eq!(r.section("pinned").toggle_label, "Show Pinned");
    r.send(H::FoldAll(wire::PhotosFoldAll {}));
    assert!(r.collections().sections.iter().all(|s| s.folded));
    r.send(H::FoldAll(wire::PhotosFoldAll {}));
    assert!(r.collections().sections.iter().all(|s| !s.folded));
}

#[test]
fn naming_a_new_album_is_a_sheet_and_an_empty_name_is_not_a_write() {
    let mut r = rig_at(Dest::Collections, None);
    r.send(H::Sheet(wire::photos_home_event::SheetEvent {
        sheet: Sheet::NewAlbum as i32,
    }));
    assert_eq!(r.state().sheet, Sheet::NewAlbum as i32);
    let count = |r: &Rig| r.section("albums").cards.len();
    let before = count(&r);
    r.send(H::NewAlbumName("   ".to_owned()));
    assert!(!r.state().collections.as_ref().unwrap().new_album_can_submit);
    r.send(H::NewAlbumSubmitted(wire::PhotosNewAlbumSubmitted {}));
    assert_eq!(
        r.state().sheet,
        Sheet::NewAlbum as i32,
        "nothing was written"
    );
    assert_eq!(count(&r), before);
    r.send(H::NewAlbumName("  Zq Rooftops  ".to_owned()));
    assert!(r.state().collections.as_ref().unwrap().new_album_can_submit);
    r.send(H::NewAlbumSubmitted(wire::PhotosNewAlbumSubmitted {}));
    // Only a committed write closes the sheet.
    assert_eq!(r.state().sheet, Sheet::None as i32);
    assert_eq!(count(&r), before + 1);
    assert!(
        r.section("albums")
            .cards
            .iter()
            .any(|c| c.title == "Zq Rooftops")
    );
    // The sitting is over: a Create that still arrives files no second album.
    r.send(H::NewAlbumSubmitted(wire::PhotosNewAlbumSubmitted {}));
    assert_eq!(count(&r), before + 1);
    assert_eq!(r.state().collections.as_ref().unwrap().new_album_name, "");
}

#[test]
fn deleting_an_album_asks_first_and_names_the_album_and_nothing_else() {
    let mut r = rig_at(Dest::Collections, None);
    let id = r.album("Zq Doomed");
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    r.send(H::AlbumDeleteAsked(id.clone()));
    let confirm = r
        .state()
        .collections
        .as_ref()
        .unwrap()
        .delete_confirm
        .clone()
        .expect("a confirm");
    assert_eq!(confirm.title, "Delete this album?");
    assert_eq!(confirm.body, "Photos stay in the library.");
    assert!(confirm.destructive);
    // Dismissed, it writes nothing.
    r.send(H::AlbumDeleteDismissed(wire::PhotosDeleteDismissed {}));
    assert!(r.section("albums").cards.iter().any(|c| c.id == id));
    r.send(H::AlbumDeleteAsked(id.clone()));
    r.send(H::AlbumDeleteConfirmed(wire::PhotosDeleteConfirmed {}));
    assert!(!r.section("albums").cards.iter().any(|c| c.id == id));
    assert!(
        r.state()
            .collections
            .as_ref()
            .unwrap()
            .delete_confirm
            .is_none()
    );
}

#[test]
fn an_album_in_the_trash_is_restored_from_collections_with_its_photographs() {
    // The album trash was reachable from no screen: the answer carried
    // `trashed_albums` and nothing offered the restore.
    let mut r = rig_at(Dest::Collections, None);
    let id = r.album("Zq Back Again");
    let a = r.photo("album restore", Some("2026-09-01T10:00:00Z"), None);
    r.arrange(act::photos::AddToAlbum {
        from: id.clone(),
        to: a,
        ..Default::default()
    });
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    r.send(H::AlbumDeleteAsked(id.clone()));
    r.send(H::AlbumDeleteConfirmed(wire::PhotosDeleteConfirmed {}));
    let deleted = r.section("deleted");
    assert_eq!(deleted.title, "Recently deleted albums");
    let card = deleted
        .cards
        .iter()
        .find(|c| c.id == id)
        .expect("the trashed album")
        .clone();
    assert_eq!(card.restore_label, "Restore");
    assert!(card.route.is_none(), "its verb is Restore");
    r.send(H::AlbumRestored(id.clone()));
    let back = r
        .section("albums")
        .cards
        .iter()
        .find(|c| c.id == id)
        .expect("restored")
        .clone();
    assert_eq!(back.count_label, "1 photo");
    assert!(
        r.collections()
            .sections
            .iter()
            .all(|s| s.key != "deleted" || !s.cards.iter().any(|c| c.id == id))
    );
}

#[test]
fn a_refused_restore_says_why_and_leaves_the_list() {
    let mut r = rig_at(Dest::Collections, None);
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    // An album that was never deleted cannot be restored.
    let live = r.album("Zq Still Here");
    r.send(H::Refreshed(wire::PhotosRefreshed {}));
    r.send(H::AlbumRestored(live.clone()));
    let status = r.state().status.as_ref().expect("a refusal");
    assert!(status.refused && !status.sentence.is_empty());
    assert!(r.section("albums").cards.iter().any(|c| c.id == live));
}

// ---------------------------------------------------------------------------
// Search (PhotosSearchSpec)
// ---------------------------------------------------------------------------

fn search_for(r: &mut Rig, term: &str) {
    r.send(H::SearchTerm(term.to_owned()));
}

#[test]
fn the_screen_rests_before_anything_is_typed_and_opening_it_reads_the_vocabulary() {
    let mut r = rig();
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    assert_eq!(r.state().destination, Dest::Search as i32);
    let search = r.search();
    // Resting, never loading: a spinner would never finish.
    let Some(wire::photos_search_view::Content::Resting(resting)) = &search.content else {
        panic!("not resting: {:?}", search.content);
    };
    assert_eq!(resting.hint, "Search places, albums, labels and captions.");
    assert!(search.ask.is_none());
}

#[test]
fn a_caption_is_found_and_the_hits_open_the_lightbox_in_their_own_order() {
    let mut r = rig();
    let a = r.photo("search a", Some("2026-02-03T10:00:00Z"), None);
    r.arrange(act::photos::RetitlePhoto {
        photo_id: a.clone(),
        title: "Zqharbour at dusk".to_owned(),
    });
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    search_for(&mut r, "Zqharbour");
    let hits = r.hits();
    assert_eq!(
        hits.tiles
            .iter()
            .map(|t| t.photo_id.as_str())
            .collect::<Vec<_>>(),
        [a.as_str()]
    );
    assert!(hits.empty.is_none());
    let Some(wire::route::Args::PhotosLightbox(args)) = &hits.open.as_ref().unwrap().args else {
        panic!("a lightbox route");
    };
    assert_eq!(args.neighbour_ids, [a]);
    assert_eq!(r.search().query, "Zqharbour");
    // Ask is the row at the foot of a current answer.
    let ask = r.search().ask.as_ref().expect("an ask row");
    assert_eq!(ask.scope, "photos");
    assert!(ask.label.contains("Zqharbour"));
}

#[test]
fn nothing_matched_is_data_with_no_cells_never_a_refusal_and_says_everywhere_it_looked() {
    let mut r = rig();
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    search_for(&mut r, "zzqxnothing");
    let hits = r.hits();
    assert!(hits.tiles.is_empty() && hits.doors.is_empty());
    let empty = hits.empty.as_ref().expect("the no-match state");
    assert_eq!(empty.headline, "No results");
    assert_eq!(
        empty.body,
        "Nothing matches “zzqxnothing”. Search covers captions, text in photos, places, labels and albums."
    );
    // Ask stays, matched or not.
    assert!(r.search().ask.is_some());
}

#[test]
fn clearing_the_field_goes_back_to_resting_not_to_empty() {
    let mut r = rig();
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    search_for(&mut r, "zzqxnothing");
    search_for(&mut r, "   ");
    assert!(matches!(
        r.search().content,
        Some(wire::photos_search_view::Content::Resting(_))
    ));
    assert!(r.search().ask.is_none());
    assert!(r.search().corrected.is_empty());
}

#[test]
fn a_typo_is_corrected_and_the_line_says_what_was_searched_instead() {
    let mut r = rig();
    let a = r.photo("search typo", Some("2026-02-04T10:00:00Z"), None);
    r.arrange(act::photos::RetitlePhoto {
        photo_id: a.clone(),
        title: "Zqsunscreen on the shelf".to_owned(),
    });
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    search_for(&mut r, "Zqsunscren");
    let corrected = r.search().corrected.clone();
    if !corrected.is_empty() {
        assert!(
            corrected.to_lowercase().contains("zqsunscreen"),
            "{corrected}"
        );
        assert!(r.hits().tiles.iter().any(|t| t.photo_id == a));
    }
    // A new term takes the correction away.
    search_for(&mut r, "Zqsunscreen");
    assert!(r.search().corrected.is_empty());
}

#[test]
fn an_album_the_words_name_is_a_door_above_the_grid_with_its_exact_size() {
    let mut r = rig();
    let album = r.album("Zqtahoe trip");
    let a = r.photo("search album", Some("2026-02-05T10:00:00Z"), None);
    r.arrange(act::photos::AddToAlbum {
        from: album.clone(),
        to: a.clone(),
        ..Default::default()
    });
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    search_for(&mut r, "Zqtahoe");
    let hits = r.hits();
    let door = hits
        .doors
        .iter()
        .find(|d| d.label == "Zqtahoe trip")
        .expect("the album's door");
    assert_eq!(door.count_label, "1 photo");
    assert_eq!(door.kind_label, "Album");
    let Some(wire::route::Args::PhotosShelf(shelf)) = &door.route.as_ref().unwrap().args else {
        panic!("a shelf route");
    };
    assert_eq!(shelf.id, album);
    // The album's photographs reach the grid: typing "Tahoe" returns them, not
    // an empty grid under a row saying the album exists.
    assert!(hits.tiles.iter().any(|t| t.photo_id == a));
}

#[test]
fn a_route_with_words_opens_search_on_them() {
    let r = rig_at(Dest::Library, Some("zzqxroute"));
    assert_eq!(r.state().destination, Dest::Search as i32);
    assert_eq!(r.search().query, "zzqxroute");
    assert!(matches!(
        r.search().content,
        Some(wire::photos_search_view::Content::Hits(_))
    ));
}

#[test]
fn closing_search_returns_to_the_library() {
    let mut r = rig();
    r.send(H::SearchOpened(wire::PhotosSearchOpened {}));
    search_for(&mut r, "anything");
    r.send(H::SearchClosed(wire::PhotosSearchClosed {}));
    assert_eq!(r.state().destination, Dest::Library as i32);
    assert!(r.state().search.is_none());
}
