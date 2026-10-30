//! `imports.files` through the door a shell uses: the Rust port of the KMP `FilesFollowSpec`,
//! `PhoneFollowSpec` and the gate's integration (#1135, lane I). The shell's part is played here.

mod imports_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::imports::files::{media_type_of, stat_of, usable};
use centraid_screens::kit::read;
use imports_support::{Shell, owned, stage};
use wire::app_query_response::Answer;
use wire::effect::Kind as K;
use wire::imports_files_event as files;

/// The services open together; the camera roll's first read of the grant is not this file's.
fn shell() -> Shell {
    let mut shell = imports_support::shell();
    shell.d.effects.clear();
    shell
}

fn send(shell: &mut Shell, kind: files::Kind) {
    let instance = shell.files;
    shell.d.send(
        instance,
        wire::screen_event::Kind::ImportsFiles(wire::ImportsFilesEvent { kind: Some(kind) }),
    );
}

fn state(shell: &Shell) -> wire::ImportsFilesState {
    match &shell.d.views[&shell.files].kind {
        Some(wire::view_state::Kind::ImportsFiles(state)) => state.clone(),
        other => panic!("files draws {other:?}"),
    }
}

fn held(shell: &Shell) -> wire::ImportsFilesHeld {
    shell.d.with_ctx(|ctx| {
        match read::read(
            ctx,
            load::shell::FilesFollowed::default(),
            |answer| match answer {
                Answer::ImportsFilesHeld(held) => Some(held),
                _ => None,
            },
        ) {
            read::Reading::Data(held) => held,
            _ => panic!("the followed folders read"),
        }
    })
}

fn follow(shell: &mut Shell, origin: &str, name: &str) {
    send(
        shell,
        files::Kind::FolderFollowed(files::FolderFollowed {
            origin: origin.to_owned(),
            name: name.to_owned(),
        }),
    );
}

fn file(path: &str, size: u64, modified_ms: i64) -> wire::FolderFile {
    wire::FolderFile {
        path: path.to_owned(),
        size,
        modified_ms,
        media_type: String::new(),
    }
}

fn listing(origin: &str, files: Vec<wire::FolderFile>, complete: bool) -> wire::FoldersListing {
    wire::FoldersListing {
        complete,
        device_id: "device-1".to_owned(),
        folders: vec![wire::FolderListed {
            origin: origin.to_owned(),
            label: "Taxes".to_owned(),
            files,
        }],
    }
}

/// The effects of this service not yet answered, by kind name.
fn asked(shell: &Shell) -> Vec<String> {
    shell
        .d
        .effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            K::FoldersRead(_) => Some("read".to_owned()),
            K::StageFolderFile(stage) => Some(format!("stage:{}", stage.path)),
            _ => None,
        })
        .collect()
}

/// Wait out the settle time: the gate's two seconds, then the pass starts.
fn settle(shell: &mut Shell) {
    shell.d.pump(Duration::from_millis(2_600));
}

/// Answer the stage the way a shell does: through the real stage door.
fn stage_pending(shell: &mut Shell, content: &[u8]) -> wire::StageHandle {
    let request = shell.d.effects.first().cloned().expect("a stage is asked");
    let Some(K::StageFolderFile(ask)) = request.effect.and_then(|e| e.kind) else {
        panic!("a stage is asked");
    };
    let handle = stage(&shell.d, owned(&ask.media_type, content), content);
    shell
        .d
        .answer_effect(wire::effect_result::Outcome::FolderFileStaged(
            wire::FolderFileStaged {
                ok: true,
                content_hash: handle.content_hash.clone(),
                byte_size: handle.byte_size,
            },
        ));
    handle
}

fn answer_listing(shell: &mut Shell, listing: wire::FoldersListing) {
    shell
        .d
        .answer_effect(wire::effect_result::Outcome::FoldersListing(listing));
}

/// One followed folder with `report.pdf` filed once; returns the shell.
fn followed_with_a_file() -> Shell {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "  Taxes  ");
    settle(&mut shell);
    assert_eq!(asked(&shell), vec!["read"]);
    answer_listing(
        &mut shell,
        listing("folder:abc", vec![file("2026/report.pdf", 12, 100)], true),
    );
    assert_eq!(asked(&shell), vec!["stage:2026/report.pdf"]);
    stage_pending(&mut shell, b"report bytes");
    shell
}

#[test]
fn a_vault_that_follows_no_folder_is_never_read() {
    let mut shell = shell();
    send(&mut shell, files::Kind::Requested(files::Requested {}));
    settle(&mut shell);
    assert!(
        asked(&shell).is_empty(),
        "a foreground pass never imports into a vault that never followed"
    );
}

#[test]
fn following_a_folder_makes_its_docs_folder_then_the_origin_that_fills_it() {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "  Taxes  ");
    let held = held(&shell);
    assert_eq!(held.folders.len(), 1);
    assert_eq!(held.folders[0].origin_ref, "folder:abc");
    assert_eq!(held.folders[0].label, "Taxes");
}

#[test]
fn following_a_folder_already_followed_makes_no_second_docs_folder() {
    let mut shell = shell();
    let docs_folders = |shell: &Shell| -> usize {
        shell.d.with_ctx(|ctx| {
            match read::read(
                ctx,
                load::docs::Drive {
                    limit: 200,
                    ..load::docs::Drive::default()
                },
                |answer| match answer {
                    Answer::DocsDrive(drive) => Some(drive),
                    _ => None,
                },
            ) {
                read::Reading::Data(drive) => drive.folders.len(),
                _ => panic!("the drive reads"),
            }
        })
    };
    let before = docs_folders(&shell);
    follow(&mut shell, "folder:abc", "Taxes");
    assert_eq!(docs_folders(&shell), before + 1);
    follow(&mut shell, "folder:abc", "Taxes");
    assert_eq!(docs_folders(&shell), before + 1);
    assert_eq!(held(&shell).folders.len(), 1);
}

#[test]
fn a_new_file_is_staged_claimed_at_the_size_the_core_counted_and_sent_as_one_record() {
    let shell = followed_with_a_file();
    let held = held(&shell);
    assert_eq!(
        held.folders[0].documents, 1,
        "one document follows the file"
    );
    assert_eq!(
        held.folders[0].files,
        vec![wire::ImportsHeldFile {
            path: "2026/report.pdf".to_owned(),
            stat: "12:100".to_owned()
        }]
    );
    assert!(!state(&shell).running, "the pass ended");
}

#[test]
fn a_rescan_of_an_unchanged_folder_stages_nothing_and_sends_the_stat_alone() {
    let mut shell = followed_with_a_file();
    send(&mut shell, files::Kind::Requested(files::Requested {}));
    settle(&mut shell);
    assert_eq!(asked(&shell), vec!["read"]);
    answer_listing(
        &mut shell,
        listing("folder:abc", vec![file("2026/report.pdf", 12, 100)], true),
    );
    assert!(
        asked(&shell).is_empty(),
        "no bytes asked for an unchanged file"
    );
    assert_eq!(held(&shell).folders[0].documents, 1);
}

#[test]
fn a_file_whose_size_or_time_moved_is_read_again_and_only_that_file() {
    let mut shell = followed_with_a_file();
    send(&mut shell, files::Kind::Requested(files::Requested {}));
    settle(&mut shell);
    answer_listing(
        &mut shell,
        listing(
            "folder:abc",
            vec![
                file("2026/report.pdf", 12, 200),
                file("2026/other.txt", 5, 100),
            ],
            true,
        ),
    );
    // the moved file, then the new one
    assert_eq!(asked(&shell), vec!["stage:2026/report.pdf"]);
    stage_pending(&mut shell, b"report bytes, edited");
    assert_eq!(asked(&shell), vec!["stage:2026/other.txt"]);
    stage_pending(&mut shell, b"other");
    let held = held(&shell);
    assert_eq!(held.folders[0].documents, 2);
    let stat = |path: &str| {
        held.folders[0]
            .files
            .iter()
            .find(|f| f.path == path)
            .map(|f| f.stat.clone())
    };
    assert_eq!(stat("2026/report.pdf").as_deref(), Some("12:200"));
    assert_eq!(stat("2026/other.txt").as_deref(), Some("5:100"));
}

#[test]
fn a_file_that_would_not_read_is_not_sent_and_the_pass_still_ends() {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "Taxes");
    settle(&mut shell);
    answer_listing(
        &mut shell,
        listing(
            "folder:abc",
            vec![file("a.pdf", 3, 1), file("b.pdf", 4, 1)],
            true,
        ),
    );
    // a.pdf would not read
    shell
        .d
        .answer_effect(wire::effect_result::Outcome::FolderFileStaged(
            wire::FolderFileStaged::default(),
        ));
    assert_eq!(asked(&shell), vec!["stage:b.pdf"]);
    stage_pending(&mut shell, b"bbbb");
    let held = held(&shell);
    assert_eq!(
        held.folders[0].documents, 1,
        "only the file that read is filed"
    );
    assert!(!state(&shell).running);
}

#[test]
fn hidden_files_empty_files_and_a_path_met_twice_are_not_records() {
    assert!(!usable(&file(".hidden", 3, 1)));
    assert!(!usable(&file("dir/.git/config", 3, 1)));
    assert!(!usable(&file("empty.txt", 0, 1)));
    assert!(!usable(&file("dir/", 3, 1)));
    assert!(usable(&file("dir/real.txt", 3, 1)));

    let mut shell = shell();
    follow(&mut shell, "folder:abc", "Taxes");
    settle(&mut shell);
    answer_listing(
        &mut shell,
        listing(
            "folder:abc",
            vec![
                file(".hidden", 3, 1),
                file("empty.txt", 0, 1),
                file("twice.txt", 3, 1),
                file("twice.txt", 3, 1),
            ],
            true,
        ),
    );
    assert_eq!(asked(&shell), vec!["stage:twice.txt"], "once");
    stage_pending(&mut shell, b"abc");
    assert_eq!(held(&shell).folders[0].documents, 1);
}

#[test]
fn a_media_type_off_the_name_when_the_platform_named_none() {
    assert_eq!(media_type_of("a.PDF", ""), "application/pdf");
    assert_eq!(media_type_of("a.md", "  "), "text/markdown");
    assert_eq!(media_type_of("a.bin", ""), "application/octet-stream");
    assert_eq!(media_type_of("a.pdf", "text/x-given"), "text/x-given");
    assert_eq!(stat_of(&file("a", 7, 9)), "7:9");
}

#[test]
fn a_folder_the_vault_does_not_follow_is_not_sent() {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "Taxes");
    settle(&mut shell);
    answer_listing(
        &mut shell,
        listing("folder:other", vec![file("x.txt", 3, 1)], true),
    );
    assert!(asked(&shell).is_empty());
    assert_eq!(held(&shell).folders[0].documents, 0);
}

#[test]
fn a_shell_that_cannot_read_is_a_pass_that_did_nothing_and_the_next_trigger_tries_again() {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "Taxes");
    settle(&mut shell);
    assert_eq!(asked(&shell), vec!["read"]);
    shell.d.answer_effect(wire::effect_result::Outcome::Failed(
        wire::EffectFailed::default(),
    ));
    assert!(!state(&shell).running);
    send(&mut shell, files::Kind::Requested(files::Requested {}));
    settle(&mut shell);
    assert_eq!(asked(&shell), vec!["read"]);
}

#[test]
fn a_read_that_never_answers_is_abandoned_at_the_timeout() {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "Taxes");
    settle(&mut shell);
    assert!(state(&shell).running);
    let instance = shell.files;
    shell.d.send(
        instance,
        wire::screen_event::Kind::TimerFired(wire::TimerFired {
            timer: "files-read".to_owned(),
        }),
    );
    assert!(
        !state(&shell).running,
        "one stuck read cannot hold the follow for good"
    );
}

#[test]
fn a_burst_of_triggers_is_one_pass_and_a_trigger_during_the_pass_queues_one_more() {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "Taxes");
    for _ in 0..5 {
        send(&mut shell, files::Kind::Requested(files::Requested {}));
    }
    settle(&mut shell);
    assert_eq!(asked(&shell), vec!["read"], "one pass for the burst");
    // triggers during the pass
    for _ in 0..4 {
        send(&mut shell, files::Kind::Requested(files::Requested {}));
    }
    answer_listing(&mut shell, listing("folder:abc", vec![], true));
    // THE QUEUED PASS STARTS AT ONCE when the pass in flight ends, and no third follows.
    assert_eq!(asked(&shell), vec!["read"]);
    answer_listing(&mut shell, listing("folder:abc", vec![], true));
    assert!(asked(&shell).is_empty());
}

#[test]
fn stopping_a_folder_is_the_vaults_follow_stop_and_every_document_stays() {
    let mut shell = followed_with_a_file();
    send(
        &mut shell,
        files::Kind::FolderStopped(files::FolderStopped {
            origin: "folder:abc".to_owned(),
        }),
    );
    assert!(held(&shell).folders.is_empty(), "the origin is retired");
    // A trigger now reads nothing: no folder is followed.
    send(&mut shell, files::Kind::Requested(files::Requested {}));
    settle(&mut shell);
    assert!(asked(&shell).is_empty());
}

#[test]
fn the_followed_list_is_the_vaults_origins_with_the_documents_each_holds_by_name() {
    let mut shell = shell();
    follow(&mut shell, "folder:b", "zebra");
    follow(&mut shell, "folder:a", "Alpha");
    let held = held(&shell);
    let names: Vec<&str> = held
        .folders
        .iter()
        .map(|folder| folder.label.as_str())
        .collect();
    assert_eq!(names, vec!["Alpha", "zebra"]);
    assert!(held.folders.iter().all(|folder| folder.documents == 0));
}

/// The documents in Docs' trash, read the way the drive reads its Trash shelf.
fn trashed(shell: &Shell) -> usize {
    shell.d.with_ctx(|ctx| {
        match read::read(
            ctx,
            load::docs::Drive {
                shelf: Some("trash".to_owned()),
                ..Default::default()
            },
            |answer| match answer {
                Answer::DocsDrive(drive) => Some(drive),
                _ => None,
            },
        ) {
            read::Reading::Data(drive) => drive.documents.len(),
            _ => panic!("the drive's trash reads"),
        }
    })
}

/// A folder followed with `count` files, each filed.
fn followed_with(count: usize) -> Shell {
    let mut shell = shell();
    follow(&mut shell, "folder:abc", "Taxes");
    settle(&mut shell);
    let files: Vec<wire::FolderFile> = (0..count)
        .map(|n| file(&format!("f{n}.txt"), 4 + n as u64, 100))
        .collect();
    answer_listing(&mut shell, listing("folder:abc", files, true));
    for n in 0..count {
        stage_pending(&mut shell, format!("file {n} {}", "x".repeat(n)).as_bytes());
    }
    assert_eq!(held(&shell).folders[0].documents, count as u32);
    assert_eq!(trashed(&shell), 0);
    shell
}

/// A read that lost one file of six trashes that one: the ordinary case.
#[test]
fn a_complete_read_that_lost_one_file_trashes_that_one() {
    let mut shell = followed_with(6);
    send(&mut shell, files::Kind::Requested(files::Requested {}));
    settle(&mut shell);
    let kept: Vec<wire::FolderFile> = (0..5)
        .map(|n| file(&format!("f{n}.txt"), 4 + n as u64, 100))
        .collect();
    answer_listing(&mut shell, listing("folder:abc", kept, true));
    assert_eq!(trashed(&shell), 1, "the file the read lost is trashed");
}

/// A SYNC GLITCH LOOKS LIKE A MASS DELETE (R-1127-9): a complete read that lost at least five
/// followed files and more than half of them trashes nothing. Keep is the default; the KMP
/// question that let the member choose is gone with the Kotlin follower, so the safe half of it
/// stays here.
#[test]
fn a_complete_read_that_lost_most_of_a_folder_trashes_nothing() {
    let mut shell = followed_with(6);
    send(&mut shell, files::Kind::Requested(files::Requested {}));
    settle(&mut shell);
    answer_listing(
        &mut shell,
        listing("folder:abc", vec![file("f0.txt", 4, 100)], true),
    );
    assert_eq!(trashed(&shell), 0, "nothing is trashed");
    assert!(!state(&shell).running);
}
