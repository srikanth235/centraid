//! THE PLATFORM FACTS NO MACHINE HERE CAN COMPILE (#1029 W18-1, W18-3; #1135).
//!
//! Neither mobile shell is built in this container: there is no Android SDK, and
//! a Swift build needs a macOS host. A source scan is a poor substitute for a
//! compiler and does not pretend otherwise. What it catches is the specific
//! regression each test names, which is the whole of what these files got wrong
//! before:
//!
//! | Fact | What happens when it is wrong |
//! |---|---|
//! | a `BGTaskScheduler` identifier is in the plist, `project.yml` and the Swift shell | the app TERMINATES on launch with no backup and nothing a member can report |
//! | every BGTask handler completes the task on the expiration path too | the task is killed and the app is penalised in scheduling: a backup that gets rarer every time it fails |
//! | the Android worker is a CONCRETE class | WorkManager accepts the work, reports it enqueued, and every run fails inside the framework |
//! | the unique work is UPDATEd, not KEPT | a shipped build's unrunnable request is preserved for ever |
//! | ONE background `URLSession`, the iOS shell's, pinning by DER | two sessions under one identifier are undefined; a session trusting a CA trusts whoever holds a certificate for the address |
//! | the windows' names are the ones Rust schedules | a window the shell maps to nothing never runs |

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_screens::passes::windows;

fn mobile() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mobile")
}

fn read(relative: &str) -> String {
    fs::read_to_string(mobile().join(relative)).unwrap_or_else(|e| panic!("{relative}: {e}"))
}

/// The CODE, with comments dropped: every file here explains the trap it is
/// avoiding by naming it, so a scan over raw text finds the trap in the
/// paragraph that says never to write it.
fn code(source: &str) -> String {
    source
        .lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .filter(|line| !line.trim_start().starts_with('*'))
        .collect::<Vec<_>>()
        .join("\n")
}

fn files_under(root: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path
                    .file_name()
                    .is_some_and(|n| n == "build" || n == ".gradle")
                {
                    continue;
                }
                stack.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| extensions.contains(&e))
            {
                found.push(path);
            }
        }
    }
    found
}

fn swift_sources() -> String {
    files_under(&mobile().join("iosApp/Sources"), &["swift"])
        .iter()
        .map(|p| fs::read_to_string(p).expect("swift"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The ids the Swift shell submits and registers.
fn submitted() -> Vec<String> {
    let passes = read("iosApp/Sources/BackgroundPasses.swift");
    passes
        .lines()
        .filter(|line| line.contains("Identifier = \""))
        .filter_map(|line| line.split('"').nth(1).map(str::to_owned))
        .collect()
}

fn plist_array(key: &str) -> BTreeSet<String> {
    let plist = read("iosApp/Resources/Info.plist");
    let Some(start) = plist.find(&format!("<key>{key}</key>")) else {
        return BTreeSet::new();
    };
    let Some(end) = plist[start..].find("</array>") else {
        return BTreeSet::new();
    };
    plist[start..start + end]
        .split("<string>")
        .skip(1)
        .filter_map(|part| part.split("</string>").next())
        .map(str::to_owned)
        .collect()
}

fn yaml_list(key: &str) -> BTreeSet<String> {
    let yml = read("iosApp/project.yml");
    let lines: Vec<&str> = yml.lines().collect();
    let Some(at) = lines
        .iter()
        .position(|line| line.trim_start().starts_with(&format!("{key}:")))
    else {
        return BTreeSet::new();
    };
    lines[at + 1..]
        .iter()
        .take_while(|line| {
            let t = line.trim_start();
            t.is_empty() || t.starts_with('-') || t.starts_with('#')
        })
        .filter_map(|line| line.trim_start().strip_prefix('-'))
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

const KEY: &str = "BGTaskSchedulerPermittedIdentifiers";

#[test]
fn the_scan_finds_the_identifiers_at_all() {
    // A SCAN THAT MATCHES NOTHING PASSES EVERY ASSERTION BELOW.
    assert_eq!(
        submitted().len(),
        2,
        "BackgroundPasses.swift was respelled; this scan is stale"
    );
    assert!(!plist_array(KEY).is_empty() && !yaml_list(KEY).is_empty());
}

#[test]
fn every_identifier_the_shell_submits_is_declared_in_the_source_and_in_the_plist() {
    // THE DEFECT THIS WAS WRITTEN FOR: `dev.centraid.upload-pass` was in the
    // plist and not in `project.yml`, and the plist is xcodegen's OUTPUT, so the
    // built bundle declared one id and the shell submitted two.
    let declared = yaml_list(KEY);
    let plist = plist_array(KEY);
    for id in submitted() {
        assert!(
            declared.contains(&id),
            "{id} is submitted but is not in project.yml's {KEY}"
        );
        assert!(
            plist.contains(&id),
            "{id} is submitted but is not in the plist's {KEY}"
        );
    }
    // DRIFT EITHER WAY IS A FINDING.
    assert_eq!(
        plist, declared,
        "Info.plist and project.yml disagree about {KEY}"
    );
}

#[test]
fn every_identifier_has_a_registered_launch_handler_in_the_swift_shell() {
    // A SUBMIT WITH NO HANDLER IS THE SAME EXCEPTION AND THE SAME TERMINATION.
    let swift = swift_sources();
    assert!(
        swift.contains("forTaskWithIdentifier:"),
        "no BGTaskScheduler registration"
    );
    for id in submitted() {
        assert!(
            swift.contains(&format!("\"{id}\"")),
            "{id} is submitted but never named"
        );
    }
}

#[test]
fn a_handler_completes_the_task_on_the_expiration_path_as_well() {
    // A TASK THAT ENDS WITHOUT `setTaskCompleted` IS KILLED AND ITS APP IS
    // PENALISED IN SCHEDULING. The expiration handler is the path that is forgotten.
    let swift = swift_sources();
    assert!(swift.contains("expirationHandler"));
    let after = swift
        .split("expirationHandler")
        .nth(1)
        .expect("an expiration handler");
    assert!(after.contains("setTaskCompleted") || after.contains("completion.finish"));
}

#[test]
fn the_ios_windows_are_named_as_rust_schedules_them_and_wait_for_the_charger() {
    let passes = code(&read("iosApp/Sources/BackgroundPasses.swift"));
    // THE NAME RUST SCHEDULES IS THE NAME THE WINDOW REPORTS BACK UNDER.
    assert!(passes.contains(&format!("\"{}\"", windows::PERIODIC)));
    assert!(passes.contains(&format!("\"{}\"", windows::NIGHT)));
    // THE LONG WINDOW: prepare and settle wait for the charger and need a network.
    assert!(passes.contains("requiresExternalPower = true"));
    assert!(passes.contains("requiresNetworkConnectivity = true"));
    assert!(!passes.contains("requiresExternalPower = false"));
}

#[test]
fn the_android_periodic_worker_is_a_concrete_class_and_never_the_abstract_worker() {
    // WHAT SHIPPED BEFORE. `PeriodicWorkRequestBuilder<androidx.work.Worker>` names the
    // ABSTRACT base class; WorkManager instantiates a worker reflectively and that one has
    // no runnable body, so the work was enqueued and could never execute.
    let android = code(&read(
        "androidApp/src/main/kotlin/dev/centraid/android/backup/PassWork.kt",
    ));
    assert!(!android.contains("PeriodicWorkRequestBuilder<androidx.work.Worker>"));
    assert!(!android.contains("OneTimeWorkRequestBuilder<androidx.work.Worker>"));
    assert!(android.contains("PeriodicWorkRequestBuilder<CentraidSyncWorker>"));
    assert!(android.contains("class CentraidSyncWorker"));
    assert!(android.contains("CoroutineWorker"));
}

#[test]
fn the_unique_work_name_is_kept_and_the_policy_is_what_migrates_the_broken_entry() {
    // KEEP would keep exactly the unrunnable request a shipped build left behind.
    assert_eq!(windows::PERIODIC, "centraid-sync-pass");
    let android = code(&read(
        "androidApp/src/main/kotlin/dev/centraid/android/backup/PassWork.kt",
    ));
    assert!(android.contains("enqueueUniquePeriodicWork("));
    assert!(android.contains("ExistingPeriodicWorkPolicy.UPDATE"));
    assert!(!android.contains("ExistingPeriodicWorkPolicy.KEEP"));
}

#[test]
fn android_maps_the_windows_rust_sends_onto_workmanager() {
    let android = code(&read(
        "androidApp/src/main/kotlin/dev/centraid/android/backup/PassWork.kt",
    ));
    assert!(android.contains("setRequiresCharging(window.requires_charging)"));
    assert!(android.contains("WindowLink.WINDOW_LINK_UNMETERED -> NetworkType.UNMETERED"));
    // "BACK UP NOW" IS THE APP'S OWN LONG RUN (A11): Rust says when (`LongRun`); no worker of its own.
    assert!(!android.contains("CentraidBacklogWorker"));
}

#[test]
fn one_background_urlsession_carries_the_uploads_and_it_pins_the_gateway_by_der() {
    // #1080 RULING 2: the OS moves the bytes while the app is suspended, through ONE
    // background session — two live sessions under one identifier are undefined, and a second
    // identifier is a second queue nobody settles.
    let make = "URLSessionConfiguration.background(withIdentifier:";
    let sessions: Vec<(String, String)> = files_under(&mobile().join("iosApp/Sources"), &["swift"])
        .into_iter()
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                code(&fs::read_to_string(&p).expect("swift")),
            )
        })
        .filter(|(_, text)| text.contains(make))
        .collect();
    let names: Vec<_> = sessions.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["BackgroundUploads.swift"]);
    let mover = &sessions[0].1;
    assert_eq!(mover.split(make).count(), 2, "one session, made once");
    // A RELAUNCH FOR FINISHED TASKS is what settles them with the app closed.
    assert!(mover.contains("sessionSendsLaunchEvents = true"));
    // TRUST IS THE PAIRING'S: the certificate's own bytes, compared in the challenge.
    assert!(mover.contains("didReceive challenge: URLAuthenticationChallenge"));
    assert!(mover.contains("SecCertificateCopyData("));
    // AND NO KOTLIN MAKES ONE, nor names v0's retired seam.
    for file in files_under(&mobile().join("shared/src"), &["kt"]) {
        if file.components().any(|c| c.as_os_str() == "jvmTest") {
            continue;
        }
        let text = code(&fs::read_to_string(&file).expect("kotlin"));
        assert!(
            !text.contains("backgroundSessionConfigurationWithIdentifier")
                && !text.contains("BackgroundTransfers"),
            "{} makes a background session in Kotlin",
            file.display()
        );
    }
}
