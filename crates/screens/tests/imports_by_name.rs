//! The phone imports reach the screens they serve by name (#1135), in the runtime a shell
//! attaches: the camera roll tells Photos' home what it says and takes its asks, the made vault
//! asks the photo prompt itself, the Docs drive hands a followed folder to the follower, and the
//! follower follows again when the app comes forward. No shell relays any of it.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::kit::read;
use centraid_screens::testing::Driver;
use centraid_screens::{docs, photos};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

fn standard() -> Driver {
    let mut d = Driver::with_runtime(centraid_screens::standard());
    d.start();
    d
}

/// The root instance of `tab`.
fn root(d: &Driver, tab: &str) -> u64 {
    d.navigation
        .as_ref()
        .expect("a navigation")
        .tabs
        .iter()
        .find(|stack| stack.tab == tab)
        .and_then(|stack| stack.entries.first())
        .map(|entry| entry.instance)
        .unwrap_or_else(|| panic!("no {tab} tab"))
}

/// The effects `instance` asked for and nobody answered, oldest first.
fn asked(d: &Driver, instance: u64) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter(|request| request.instance == instance)
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

/// Answer the oldest effect of `instance` that `wanted` picks.
fn answer(
    d: &mut Driver,
    instance: u64,
    wanted: impl Fn(&wire::effect::Kind) -> bool,
    outcome: wire::effect_result::Outcome,
) {
    let at = d
        .effects
        .iter()
        .position(|request| {
            request.instance == instance
                && request
                    .effect
                    .as_ref()
                    .and_then(|effect| effect.kind.as_ref())
                    .is_some_and(&wanted)
        })
        .expect("the effect was asked");
    let request = d.effects.remove(at);
    d.send(
        instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn is_permission(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::LibraryPermission(_))
}

fn read(permission: wire::PhotosMediaPermission) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::LibraryPermissionRead(wire::LibraryPermissionRead {
        permission: permission as i32,
    })
}

fn photos_home(d: &Driver, instance: u64) -> wire::PhotosHomeState {
    match &d.view(instance).kind {
        Some(wire::view_state::Kind::PhotosHome(state)) => (**state).clone(),
        other => panic!("not Photos' home: {other:?}"),
    }
}

#[test]
fn photos_home_hears_the_grant_from_the_camera_roll_and_asks_it_for_the_prompt_by_name() {
    let mut d = standard();
    let roll = root(&d, "imports-camera-roll");
    let home = d.push(
        "home",
        photos::routes::home(wire::PhotosDestination::Library, None),
    );
    // THE HOME ASKS THE SHELL FOR NOTHING: the roll is told it opened and reads the grant.
    assert!(asked(&d, home).iter().all(|kind| !matches!(
        kind,
        wire::effect::Kind::CameraRoll(_) | wire::effect::Kind::LibraryPermission(_)
    )));
    assert!(asked(&d, roll).iter().any(is_permission));
    while asked(&d, roll).iter().any(is_permission) {
        answer(
            &mut d,
            roll,
            is_permission,
            read(wire::PhotosMediaPermission::Denied),
        );
    }
    // The roll told the home: a denied grant's remedy is Settings, in the grant's own sentence.
    let banner = photos_home(&d, home)
        .import_banner
        .expect("the home heard the grant");
    assert_eq!(
        banner.remedy,
        wire::photos_home_import_banner::Remedy::Settings as i32
    );
    // The member's "Allow" is the roll's prompt, asked by name.
    d.send(
        home,
        E::PhotosHome(wire::PhotosHomeEvent {
            kind: Some(wire::photos_home_event::Kind::Remedy(
                wire::PhotosBannerRemedy {
                    remedy: wire::photos_home_import_banner::Remedy::Ask as i32,
                },
            )),
        }),
    );
    assert!(
        asked(&d, home)
            .iter()
            .all(|kind| !matches!(kind, wire::effect::Kind::CameraRoll(_)))
    );
    assert!(asked(&d, roll).iter().any(|kind| matches!(
        kind,
        wire::effect::Kind::LibraryPermission(wire::LibraryPermission { ask: true })
    )));
}

#[test]
fn a_made_vault_asks_the_photo_prompt_itself_and_a_grant_starts_the_rolls_walk() {
    let mut d = standard();
    let roll = root(&d, "imports-camera-roll");
    let made = root(&d, "imports-made");
    while asked(&d, roll).iter().any(is_permission) {
        answer(
            &mut d,
            roll,
            is_permission,
            read(wire::PhotosMediaPermission::NotAsked),
        );
    }
    d.send(
        made,
        E::ImportsMade(wire::ImportsMadeEvent {
            kind: Some(wire::imports_made_event::Kind::Made(
                wire::imports_made_event::Made { reminders: false },
            )),
        }),
    );
    assert!(asked(&d, made).iter().any(|kind| matches!(
        kind,
        wire::effect::Kind::LibraryPermission(wire::LibraryPermission { ask: true })
    )));
    answer(
        &mut d,
        made,
        is_permission,
        read(wire::PhotosMediaPermission::Granted),
    );
    // THE WALK BEGINS: the roll reads the grant at the head of its walk.
    assert!(asked(&d, roll).iter().any(|kind| matches!(
        kind,
        wire::effect::Kind::LibraryPermission(wire::LibraryPermission { ask: false })
    )));
}

/// The folders the vault holds as followed (`shell.files-followed`), by the phone's origin.
fn files_followed(d: &Driver) -> Vec<String> {
    d.with_ctx(|ctx| {
        match read::read(
            ctx,
            load::shell::FilesFollowed::default(),
            |answer| match answer {
                Answer::ImportsFilesHeld(held) => Some(held),
                _ => None,
            },
        ) {
            read::Reading::Data(held) => held
                .folders
                .into_iter()
                .map(|folder| folder.origin_ref)
                .collect(),
            _ => panic!("the followed folders read"),
        }
    })
}

#[test]
fn the_drive_hands_a_followed_folder_to_the_follower_which_follows_again_when_the_app_returns() {
    let mut d = standard();
    let files = root(&d, "imports-files");
    let drive = d.push(
        "home",
        docs::routes::drive(wire::DocsDestination::Unspecified, "", "", ""),
    );
    // The member picked a folder; the shell answers the drive's `FollowFolder`.
    d.send(
        drive,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::FolderFollowed(
                wire::FolderFollowed {
                    origin: "folder:7f1c".to_owned(),
                    name: "Scans".to_owned(),
                },
            )),
        }),
    );
    d.pump(Duration::from_millis(200));
    assert_eq!(files_followed(&d), ["folder:7f1c"]);
    // THE APP CAME FORWARD: the follower reads the folder again once it settles.
    d.effects.clear();
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: true,
    }));
    for _ in 0..80 {
        if asked(&d, files)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::FoldersRead(_)))
        {
            break;
        }
        d.pump(Duration::from_millis(50));
    }
    assert!(
        asked(&d, files)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::FoldersRead(read) if read.origins == ["folder:7f1c"]))
    );
}
