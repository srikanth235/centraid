//! `imports.camera_roll` through the door a shell uses: the Rust port of the KMP `CameraRollSpec`,
//! `CameraRollStreamSpec` and `CameraRollRunnerSpec` (#1135, lane I). The shell's part is played by
//! `imports_support`, over a real vault and its real stage door.

mod imports_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::imports::camera_roll::{
    add_request, can_enumerate, cursor_key, may_fetch, permission_sentence,
};
use centraid_screens::kit::read;
use centraid_screens::passes::TransferRule as Rule;
use centraid_screens::strings::Locale;
use imports_support::{
    Library, Shell, choose, live, photo, resource, rule, serve_library, shell, shell_over,
    shell_with, wifi,
};
use wire::PhotosMediaPermission as Permission;
use wire::app_query_response::Answer;
use wire::imports_camera_roll_event as roll;

const STILL: &[u8] = b"a still, nine bytes";
const MOVIE: &[u8] = b"a movie";

fn send(shell: &mut Shell, kind: roll::Kind) {
    let instance = shell.roll;
    shell.d.send(
        instance,
        wire::screen_event::Kind::ImportsCameraRoll(wire::ImportsCameraRollEvent {
            vault_id: "vault-1".to_owned(),
            kind: Some(kind),
        }),
    );
}

fn walk(shell: &mut Shell, library: &mut Library) {
    send(shell, roll::Kind::Walk(roll::Walk {}));
    serve_library(shell, library);
}

fn state(shell: &Shell) -> wire::ImportsCameraRollState {
    match &shell.d.views[&shell.roll].kind {
        Some(wire::view_state::Kind::ImportsCameraRoll(state)) => state.clone(),
        other => panic!("the camera roll draws {other:?}"),
    }
}

fn phase(shell: &Shell) -> i32 {
    state(shell).backup.expect("a backup").phase
}

fn reason(shell: &Shell) -> String {
    state(shell).backup.expect("a backup").paused_reason
}

/// A started shell whose grant has been read.
fn started(library: &mut Library) -> Shell {
    let mut shell = shell();
    serve_library(&mut shell, library);
    shell
}

fn photographs(shell: &Shell) -> usize {
    shell.d.with_ctx(|ctx| {
        match read::read(
            ctx,
            load::photos::Shelf {
                limit: 500,
                view: load::photos::ShelfView::Live,
                after: None,
                id: None,
            },
            |answer| match answer {
                Answer::PhotosShelf(shelf) => Some(*shelf),
                _ => None,
            },
        ) {
            read::Reading::Data(shelf) => shelf.cells.len(),
            _ => panic!("the shelf reads"),
        }
    })
}

// ---- the grant ----

#[test]
fn a_limited_selection_is_a_library_not_a_denial() {
    assert!(can_enumerate(Permission::Limited));
    assert!(can_enumerate(Permission::Granted));
    for no in [
        Permission::Denied,
        Permission::Restricted,
        Permission::NotAsked,
    ] {
        assert!(!can_enumerate(no), "{no:?}");
    }
}

#[test]
fn a_grant_is_worded_in_four_sentences_and_none_blames_the_member() {
    let l = Locale::En;
    assert_eq!(permission_sentence(l, Permission::Granted), "");
    assert_eq!(
        permission_sentence(l, Permission::Limited),
        "Centraid imports the photos you selected."
    );
    assert_eq!(
        permission_sentence(l, Permission::NotAsked),
        "Centraid needs access to your photos to import them."
    );
    assert_eq!(
        permission_sentence(l, Permission::Denied),
        "Photo access is off. Turn it on in Settings to import your camera roll."
    );
    assert_eq!(
        permission_sentence(l, Permission::Restricted),
        "This phone does not allow photo access."
    );
    for permission in [
        Permission::Granted,
        Permission::Limited,
        Permission::NotAsked,
        Permission::Denied,
        Permission::Restricted,
    ] {
        let sentence = permission_sentence(l, permission).to_lowercase();
        for blame in ["you denied", "you refused", "you did not"] {
            assert!(!sentence.contains(blame), "{sentence}");
        }
    }
}

#[test]
fn an_existing_grant_is_on_the_screen_as_soon_as_it_starts_and_a_start_never_asks() {
    let mut library = Library::new();
    library.permission = Permission::Limited;
    let shell = started(&mut library);
    assert_eq!(library.prompts, 0, "a read is never an ask");
    // LIMITED IS FIRST-CLASS: never read as not asked.
    assert_eq!(state(&shell).permission, Permission::Limited as i32);
}

#[test]
fn a_grant_that_arrives_after_start_is_seen_by_the_next_walk() {
    let mut library = Library::new();
    library.permission = Permission::NotAsked;
    let mut shell = started(&mut library);
    assert_eq!(state(&shell).permission, Permission::NotAsked as i32);
    library.permission = Permission::Granted;
    walk(&mut shell, &mut library);
    assert_eq!(state(&shell).permission, Permission::Granted as i32);
}

#[test]
fn a_photos_home_opening_rereads_the_grant_and_never_asks() {
    let mut library = Library::new();
    library.permission = Permission::NotAsked;
    let mut shell = started(&mut library);
    assert_eq!(state(&shell).permission, Permission::NotAsked as i32);
    // A grant that landed after the session attached (Settings, a launch prompt).
    library.permission = Permission::Granted;
    send(
        &mut shell,
        roll::Kind::Requested(roll::Requested {
            action: roll::requested::Action::ReadPermission as i32,
        }),
    );
    serve_library(&mut shell, &mut library);
    assert_eq!(state(&shell).permission, Permission::Granted as i32);
    assert_eq!(library.prompts, 0);
    assert!(library.pages.is_empty(), "a read walks nothing");
}

#[test]
fn the_screens_ask_is_one_prompt_and_a_grant_starts_the_walk() {
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    library.permission = Permission::NotAsked;
    library.prompt_grants = Permission::Granted;
    let mut shell = started(&mut library);
    send(
        &mut shell,
        roll::Kind::Requested(roll::Requested {
            action: roll::requested::Action::AskPermission as i32,
        }),
    );
    serve_library(&mut shell, &mut library);
    assert_eq!(library.prompts, 1);
    assert_eq!(state(&shell).permission, Permission::Granted as i32);
    assert_eq!(state(&shell).imported_total, 1, "the grant walked the roll");
}

#[test]
fn a_refused_prompt_walks_nothing() {
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    library.permission = Permission::NotAsked;
    library.prompt_grants = Permission::Denied;
    let mut shell = started(&mut library);
    send(
        &mut shell,
        roll::Kind::Requested(roll::Requested {
            action: roll::requested::Action::AskPermission as i32,
        }),
    );
    serve_library(&mut shell, &mut library);
    assert_eq!(state(&shell).permission, Permission::Denied as i32);
    assert!(library.pages.is_empty());
}

#[test]
fn a_denied_grant_leaves_the_backup_idle_and_says_why_and_enumerates_nothing() {
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    library.permission = Permission::Denied;
    let mut shell = started(&mut library);
    let seeded = photographs(&shell);
    walk(&mut shell, &mut library);
    assert_eq!(phase(&shell), wire::PhotosBackupPhase::Idle as i32);
    assert!(reason(&shell).contains("Settings"));
    assert!(
        library.pages.is_empty(),
        "a roll it may not read is not asked"
    );
    assert!(library.asked.is_empty());
    assert_eq!(photographs(&shell), seeded);
}

// ---- what may cross which link ----

fn link(online: bool, metered: bool, refused: bool) -> wire::LinkReading {
    wire::LinkReading {
        online,
        metered,
        platform_refused: refused,
    }
}

#[test]
fn wifi_only_downloads_an_icloud_original_only_on_a_link_nobody_pays_for() {
    let cellular = link(true, true, false);
    assert!(!may_fetch(&cellular, Rule::WifiOnly, false));
    assert!(may_fetch(&wifi(), Rule::WifiOnly, false));
    assert!(may_fetch(&wifi(), Rule::WifiOnly, true));
}

#[test]
fn a_platform_that_would_not_say_is_expensive_and_offline_downloads_nothing() {
    assert!(!may_fetch(&link(true, false, true), Rule::WifiOnly, false));
    assert!(!may_fetch(
        &link(false, false, false),
        Rule::WifiOnly,
        false
    ));
}

#[test]
fn manual_fetches_on_wifi_as_wifi_only_does_and_never_on_cellular() {
    assert!(may_fetch(&link(true, false, false), Rule::Manual, false));
    assert!(!may_fetch(&link(true, true, false), Rule::Manual, false));
}

#[test]
fn photos_on_cellular_downloads_a_photographs_original_there_and_never_a_videos() {
    let cellular = link(true, true, false);
    assert!(may_fetch(&cellular, Rule::WifiAndCellularPhotos, false));
    // THE FIXED RULE: a member who said "photos on cellular" did not say "a 900 MB video".
    assert!(!may_fetch(&cellular, Rule::WifiAndCellularPhotos, true));
}

/// A vault coming to the front closes every tab root and opens it again, and the roll's walk dies
/// with the root that ran it: the root opened for the vault walks the roll itself.
#[test]
fn a_roll_root_opened_for_a_vault_walks_the_roll_without_being_asked() {
    use centraid_screens::imports::routes as route;
    let mut library = Library::new();
    library.permission = Permission::Granted;
    let mut shell = started(&mut library);
    let before = library.pages.len();
    let at = shell
        .d
        .push("imports-camera-roll", route::camera_roll("vault-1"));
    assert!(at > 0);
    serve_library(&mut shell, &mut library);
    assert!(
        library.pages.len() > before,
        "a root opened for a vault read no page of the roll"
    );
    assert_eq!(library.prompts, 0, "a walk on open never asks the member");
}

/// A LAUNCH WALKS BEFORE ANY VAULT IS IN FRONT: the pass service sends the session's first walk
/// while the shelf is still opening its vaults, so the walk names no vault.
#[test]
fn a_walk_that_names_no_vault_still_reads_the_roll() {
    let mut library = Library::new();
    let mut shell = started(&mut library);
    let instance = shell.roll;
    shell.d.send(
        instance,
        wire::screen_event::Kind::ImportsCameraRoll(wire::ImportsCameraRollEvent {
            vault_id: String::new(),
            kind: Some(roll::Kind::Walk(roll::Walk {})),
        }),
    );
    serve_library(&mut shell, &mut library);
    assert!(
        !library.pages.is_empty(),
        "a walk with no vault named never asked the shell for a page"
    );
}

#[test]
fn the_cursor_is_per_vault() {
    assert!(cursor_key("vault-a").contains("vault-a"));
    assert_ne!(cursor_key("vault-a"), cursor_key("vault-b"));
}

// ---- the write ----

fn input_of(request: wire::ActRequest) -> std::collections::HashMap<String, wire::Value> {
    request.input
}

#[test]
fn the_write_names_the_staged_bytes_and_never_the_phones_own_id_for_them() {
    let mut asset = photo("9F1B2C3D-0000/L0/001");
    asset.captured_at = "2026-02-03T10:11:12Z".to_owned();
    let hash = "ab".repeat(32);
    let input = input_of(add_request(&asset, &hash, 12, "image/jpeg", false, None).into());
    for name in [
        "blob",
        "size",
        "media_type",
        "form",
        "taken_at",
        "offset_min",
    ] {
        assert!(input.contains_key(name), "{name}");
    }
    let text = |name: &str| match &input[name].kind {
        Some(wire::value::Kind::Text(text)) => text.clone(),
        other => panic!("{name} is {other:?}"),
    };
    assert_eq!(text("blob"), hash);
    assert_eq!(text("media_type"), "image/jpeg");
    assert_eq!(text("form"), "photo");
    assert_eq!(text("taken_at"), "2026-02-03T10:11:12Z");
    assert!(matches!(
        input["size"].kind,
        Some(wire::value::Kind::Integer(12))
    ));
    // `edited_from` IS EDIT LINEAGE (#711); the phone's own id is nowhere, nor is a `phash`.
    assert!(!input.contains_key("edited_from") && !input.contains_key("phash"));
    for value in input.values() {
        if let Some(wire::value::Kind::Text(text)) = &value.kind {
            assert!(
                !text.contains("9F1B2C3D"),
                "the phone's own id leaked: {text}"
            );
        }
    }
}

#[test]
fn a_live_photos_two_halves_carry_one_capture_group_and_a_burst_member_gets_none_invented() {
    let live = live("L/L0/001");
    let hash = "aa".repeat(32);
    let still = input_of(add_request(&live, &hash, 1, "image/heic", false, None).into());
    let movie =
        input_of(add_request(&live, &"bb".repeat(32), 1, "video/quicktime", true, None).into());
    for input in [&still, &movie] {
        assert!(
            matches!(&input["burst"].kind, Some(wire::value::Kind::Text(t)) if t == "L/L0/001")
        );
    }
    assert!(matches!(&still["form"].kind, Some(wire::value::Kind::Text(t)) if t == "photo"));
    assert!(matches!(&movie["form"].kind, Some(wire::value::Kind::Text(t)) if t == "video"));

    let mut burst = photo("B/L0/001");
    burst.capture_group.clear();
    let input =
        input_of(add_request(&burst, &"cc".repeat(32), 1, "image/jpeg", false, None).into());
    assert!(
        !input.contains_key("burst"),
        "a guess would invent a relationship"
    );
}

#[test]
fn an_edit_names_its_source_and_says_nothing_of_when_it_was_taken() {
    let asset = photo("E");
    let input = input_of(
        add_request(
            &asset,
            &"dd".repeat(32),
            1,
            "image/jpeg",
            false,
            Some("asset-1"),
        )
        .into(),
    );
    assert!(
        matches!(&input["edited_from"].kind, Some(wire::value::Kind::Text(t)) if t == "asset-1")
    );
    assert!(!input.contains_key("taken_at") && !input.contains_key("offset_min"));
}

// ---- the walk ----

#[test]
fn a_photograph_streams_from_the_library_commits_then_stages_its_two_derivatives() {
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    let mut shell = started(&mut library);
    let seeded = photographs(&shell);
    walk(&mut shell, &mut library);

    assert_eq!(phase(&shell), wire::PhotosBackupPhase::Done as i32);
    assert_eq!(state(&shell).imported_total, 1);
    assert_eq!(photographs(&shell), seeded + 1);
    // THE PLATFORM DREW THEM; the core files them under the original.
    assert_eq!(
        library.rendered,
        vec![
            ("A".to_owned(), "thumb".to_owned()),
            ("A".to_owned(), "preview".to_owned())
        ]
    );
    assert_eq!(library.asked, vec![("A".to_owned(), true)]);
    // ADVANCED PER ASSET: a pass the OS kills resumes where it was.
    assert_eq!(
        library
            .keychain
            .get(&cursor_key("vault-1"))
            .map(String::as_str),
        Some("A")
    );
}

#[test]
fn a_live_photo_is_one_asset_two_resources_in_one_capture_group_with_derivatives_for_the_still() {
    let mut library = Library::new().with(live("L"), &[("L", STILL), ("L#pairedVideo", MOVIE)]);
    let mut shell = started(&mut library);
    walk(&mut shell, &mut library);
    let refs: Vec<&str> = library.asked.iter().map(|(r, _)| r.as_str()).collect();
    assert_eq!(refs, vec!["L", "L#pairedVideo"]);
    assert_eq!(state(&shell).imported_total, 1, "one asset");
    let rendered: std::collections::BTreeSet<&str> =
        library.rendered.iter().map(|(r, _)| r.as_str()).collect();
    assert_eq!(rendered, ["L"].into_iter().collect());
}

#[test]
fn an_original_only_in_icloud_waits_for_wifi_with_the_cursor_before_it_and_is_fetched_once_it_may_be()
 {
    let mut library = Library::new()
        .with(photo("A"), &[("A", STILL)])
        .with(photo("B"), &[("B", MOVIE)])
        .with(photo("C"), &[("C", b"third")]);
    library.in_cloud.insert("B".to_owned());
    library.link = link(true, true, false);
    let mut shell = started(&mut library);

    // STAGING IS LOCAL: the photograph on the phone goes in on cellular.
    walk(&mut shell, &mut library);
    assert_eq!(
        phase(&shell),
        wire::PhotosBackupPhase::WaitingForUnmetered as i32
    );
    assert_eq!(
        reason(&shell),
        "Some originals are only in iCloud. Centraid fetches them on Wi-Fi."
    );
    assert_eq!(state(&shell).imported_total, 1);
    assert_eq!(
        library.asked,
        vec![("A".to_owned(), false), ("B".to_owned(), false)]
    );
    assert_eq!(
        library
            .keychain
            .get(&cursor_key("vault-1"))
            .map(String::as_str),
        Some("A")
    );

    library.link = wifi();
    walk(&mut shell, &mut library);
    assert_eq!(
        &library.asked[2..],
        &[("B".to_owned(), true), ("C".to_owned(), true)][..]
    );
    assert_eq!(phase(&shell), wire::PhotosBackupPhase::Done as i32);
    assert_eq!(state(&shell).imported_total, 3);
}

#[test]
fn a_rewalk_renders_nothing_an_original_the_core_already_holds_kept_its_derivatives() {
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    let mut shell = started(&mut library);
    let seeded = photographs(&shell);
    walk(&mut shell, &mut library);
    assert_eq!(library.rendered.len(), 2);

    // A fresh keychain: the roll is walked again from the start.
    library.keychain.clear();
    walk(&mut shell, &mut library);
    assert_eq!(library.rendered.len(), 2, "a re-walk renders nothing");
    assert_eq!(state(&shell).imported_total, 1, "and imports nothing new");
    assert_eq!(photographs(&shell), seeded + 1);
}

#[test]
fn a_restored_phones_rewalk_renders_only_the_tiers_the_vault_lacks() {
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    library.derivatives_held = Some(vec!["thumb".to_owned()]);
    let mut shell = started(&mut library);
    walk(&mut shell, &mut library);
    assert_eq!(
        library.rendered,
        vec![("A".to_owned(), "preview".to_owned())]
    );

    // BOTH HELD: nothing is rendered.
    let mut whole = Library::new().with(photo("A"), &[("A", b"another still")]);
    whole.derivatives_held = Some(vec!["preview".to_owned(), "thumb".to_owned()]);
    let mut other = started(&mut whole);
    walk(&mut other, &mut whole);
    assert!(whole.rendered.is_empty());
    assert_eq!(state(&other).imported_total, 1);
}

#[test]
fn a_still_that_is_gone_skips_the_asset_and_a_movie_that_is_gone_costs_the_still_nothing() {
    let mut gone = Library::new().with(photo("A"), &[]);
    let mut shell = started(&mut gone);
    let seeded = photographs(&shell);
    walk(&mut shell, &mut gone);
    assert_eq!(state(&shell).imported_total, 0);
    assert_eq!(photographs(&shell), seeded);
    assert_eq!(phase(&shell), wire::PhotosBackupPhase::Done as i32);

    let mut library = Library::new().with(live("L"), &[("L", STILL)]);
    let mut shell = started(&mut library);
    walk(&mut shell, &mut library);
    assert_eq!(state(&shell).imported_total, 1);
    assert_eq!(library.rendered.iter().filter(|(r, _)| r == "L").count(), 2);
}

#[test]
fn a_library_change_walks_the_whole_burst_not_one_page() {
    let mut library = Library::new();
    for n in 1..=60 {
        let id = format!("P{n}");
        let bytes = format!("bytes of {id}");
        library = library.with(photo(&id), &[(&id, bytes.as_bytes())]);
    }
    let mut shell = started(&mut library);
    let seeded = photographs(&shell);
    send(
        &mut shell,
        roll::Kind::LibraryChanged(roll::LibraryChanged {}),
    );
    serve_library(&mut shell, &mut library);
    assert_eq!(state(&shell).imported_total, 60);
    assert_eq!(photographs(&shell), seeded + 60);
    assert_eq!(
        library
            .pages
            .iter()
            .map(|(_, limit)| *limit)
            .collect::<Vec<_>>(),
        vec![25, 25, 25]
    );
}

#[test]
fn triggers_during_a_walk_queue_exactly_one_more_after_it() {
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    let mut shell = started(&mut library);
    for _ in 0..3 {
        send(&mut shell, roll::Kind::Walk(roll::Walk {}));
    }
    serve_library(&mut shell, &mut library);
    // Two walks: the first imports A; the queued one reads from A's cursor and finds nothing.
    assert_eq!(
        library.pages,
        vec![(String::new(), 25), ("A".to_owned(), 25)]
    );
    assert_eq!(state(&shell).imported_total, 1);
}

#[test]
fn a_walk_resumes_from_the_cursor_the_keychain_holds() {
    let mut library = Library::new()
        .with(photo("A"), &[("A", STILL)])
        .with(photo("B"), &[("B", MOVIE)]);
    library
        .keychain
        .insert(cursor_key("vault-1"), "A".to_owned());
    let mut shell = started(&mut library);
    walk(&mut shell, &mut library);
    assert_eq!(library.asked, vec![("B".to_owned(), true)]);
    assert_eq!(library.pages[0].0, "A");
}

// ---- the bytes the core asked for again ----

fn need(content: &[u8], os_ref: &str, media_type: &str, size: u64) -> wire::NeededBytes {
    wire::NeededBytes {
        os_ref: os_ref.to_owned(),
        media_type: media_type.to_owned(),
        size,
        content_hash: centraid_vault::blob::content_digest(content),
    }
}

#[test]
fn the_need_bytes_feed_streams_each_ask_by_its_os_ref_and_only_the_hash_asked_for_counts() {
    let mut library = Library::new();
    library.bytes.insert("A".to_owned(), STILL.to_vec());
    library.bytes.insert("V".to_owned(), MOVIE.to_vec());
    let mut shell = started(&mut library);
    send(
        &mut shell,
        roll::Kind::BytesNeeded(roll::BytesNeeded {
            needs: vec![
                need(STILL, "A", "image/heic", STILL.len() as u64),
                // THE LIBRARY'S BYTES MOVED ON (an edit, a re-save): not the ask.
                need(MOVIE, "A", "image/heic", 0),
                need(STILL, "", "image/heic", 0),
                need(STILL, "gone", "image/heic", 0),
            ],
        }),
    );
    serve_library(&mut shell, &mut library);
    let s = state(&shell);
    assert_eq!((s.fed_last_round, s.fed_rounds), (1, 1));
    // The empty ref was skipped; the other three were asked.
    let refs: Vec<&str> = library.asked.iter().map(|(r, _)| r.as_str()).collect();
    assert_eq!(refs, vec!["A", "A", "gone"]);
}

#[test]
fn the_feed_downloads_from_icloud_only_where_the_rule_lets_it_cross_the_link() {
    let mut library = Library::new();
    library.bytes.insert("P".to_owned(), STILL.to_vec());
    library.bytes.insert("V".to_owned(), MOVIE.to_vec());
    library.link = link(true, true, false);
    // THE MEMBER'S RULE IS READ FROM THE PHONE'S STORE, never told by the shell.
    let secrets = rule(Rule::WifiAndCellularPhotos);
    let mut shell = shell_with(&secrets);
    serve_library(&mut shell, &mut library);
    send(
        &mut shell,
        roll::Kind::BytesNeeded(roll::BytesNeeded {
            needs: vec![
                need(STILL, "P", "image/heic", 0),
                need(MOVIE, "V", "video/quicktime", 0),
            ],
        }),
    );
    serve_library(&mut shell, &mut library);
    // A VIDEO NEVER CROSSES A METERED LINK.
    assert_eq!(
        library.asked,
        vec![("P".to_owned(), true), ("V".to_owned(), false)]
    );
    // An unknown link is metered, and WIFI_ONLY keeps even a photograph off it.
    library.asked.clear();
    library.link = link(true, false, true);
    choose(&secrets, Rule::WifiOnly);
    send(
        &mut shell,
        roll::Kind::BytesNeeded(roll::BytesNeeded {
            needs: vec![need(STILL, "P", "image/heic", 0)],
        }),
    );
    serve_library(&mut shell, &mut library);
    assert_eq!(library.asked, vec![("P".to_owned(), false)]);
}

/// What the pass service hears from the roll: a stand-in registered under its name.
struct PassEar(std::sync::Arc<std::sync::Mutex<Vec<wire::roll_reported::Kind>>>);

impl centraid_screens::screen::Screen for PassEar {
    fn update(
        &mut self,
        event: wire::ScreenEvent,
        _ctx: &centraid_screens::screen::Ctx,
    ) -> Vec<wire::Effect> {
        if let Some(wire::screen_event::Kind::RollReported(report)) = event.kind {
            self.0.lock().unwrap().extend(report.kind);
        }
        Vec::new()
    }

    fn view(&self, _ctx: &centraid_screens::screen::Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

fn listening() -> (
    Shell,
    std::sync::Arc<std::sync::Mutex<Vec<wire::roll_reported::Kind>>>,
) {
    let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let ear = heard.clone();
    let registry = centraid_screens::imports::registry(
        &centraid_screens::custody::secrets::VaultSecrets::new(),
    )
    .with(centraid_screens::passes::service::NAME, move |_| {
        Some(Box::new(PassEar(ear.clone())))
    });
    let runtime = centraid_screens::Runtime::new(registry, centraid_screens::imports::roots())
        .with_services(centraid_screens::passes::services());
    (shell_over(runtime), heard)
}

#[test]
fn the_pass_service_is_told_when_a_walk_ends_however_it_ended_and_how_much_a_feed_landed() {
    use wire::roll_reported::Kind as Reported;
    // A walk that finds its end.
    let mut library = Library::new().with(photo("A"), &[("A", STILL)]);
    let (mut shell, heard) = listening();
    serve_library(&mut shell, &mut library);
    walk(&mut shell, &mut library);
    assert!(matches!(
        heard.lock().unwrap().as_slice(),
        [Reported::Walked(_)]
    ));
    heard.lock().unwrap().clear();
    // A walk a denied grant stops: the pass runs either way, so it is told too.
    library.permission = Permission::Denied;
    walk(&mut shell, &mut library);
    assert!(matches!(
        heard.lock().unwrap().as_slice(),
        [Reported::Walked(_)]
    ));
    heard.lock().unwrap().clear();
    // A feed reports how many of its asks were staged, and the walk it did not start reports none.
    library.bytes.insert("A".to_owned(), STILL.to_vec());
    send(
        &mut shell,
        roll::Kind::BytesNeeded(roll::BytesNeeded {
            needs: vec![
                need(STILL, "A", "image/heic", STILL.len() as u64),
                need(STILL, "gone", "image/heic", 0),
            ],
        }),
    );
    serve_library(&mut shell, &mut library);
    let heard = heard.lock().unwrap();
    assert!(
        matches!(heard.as_slice(), [Reported::Fed(fed)] if fed.landed == 1),
        "{heard:?}"
    );
}

#[test]
fn the_unused_resource_helper_builds_a_role() {
    let r = resource("x", wire::roll_resource::Role::CameraOriginal);
    assert_eq!(r.role, wire::roll_resource::Role::CameraOriginal as i32);
}
