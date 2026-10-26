//! Demonstrated reds for the native rules: each rule over a fixture tree that
//! must be caught, and one that must be clean.

use std::fs;
use std::path::Path;

use super::*;
use crate::rules::RuleState;
use crate::testing::fixture_dir;

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("a parent")).expect("create fixture dirs");
    fs::write(path, contents).expect("write fixture");
}

fn findings(report: &RuleReport) -> String {
    report.findings.join("\n")
}

// ---- no-kmp-shared ----

#[test]
fn every_way_back_for_the_kmp_module_is_caught() {
    let root = fixture_dir("native-kmp-red");
    write(
        &root,
        "mobile/shared/src/commonMain/kotlin/A.kt",
        "package a\n",
    );
    write(
        &root,
        "mobile/settings.gradle.kts",
        "include(\":core\", \":shared\")\n",
    );
    write(
        &root,
        "mobile/iosApp/Sources/A.swift",
        "import SwiftUI\nimport CentraidShared\n",
    );
    write(
        &root,
        "mobile/androidApp/src/main/kotlin/B.kt",
        "package b\n\nimport dev.centraid.shared.kit.KitWords\n",
    );
    write(
        &root,
        "mobile/iosApp/project.yml",
        "      - framework: CentraidShared.xcframework\n",
    );
    write(
        &root,
        ".github/workflows/lane.yml",
        "      run: ./gradlew :shared:jvmTest\n",
    );
    let report = no_kmp_shared(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 6, "{text}");
    for expected in [
        "mobile/shared exists",
        "mobile/settings.gradle.kts:1",
        "A.swift:2: names `import CentraidShared`",
        "B.kt:3: names `dev.centraid.shared`",
        "project.yml:1: names the `CentraidShared` framework",
        "lane.yml:1: names the `:shared` Gradle module",
    ] {
        assert!(text.contains(expected), "{expected} missing from\n{text}");
    }
}

#[test]
fn a_shell_without_the_kmp_module_is_clean_and_a_comment_may_name_it() {
    let root = fixture_dir("native-kmp-green");
    write(
        &root,
        "mobile/settings.gradle.kts",
        "include(\":core\", \":androidApp\")\n",
    );
    write(
        &root,
        "mobile/iosApp/Sources/A.swift",
        "// once `import CentraidShared`\nimport SwiftUI\n",
    );
    write(
        &root,
        "mobile/iosApp/project.yml",
        "# CentraidShared is gone (#1135)\nname: Centraid\n",
    );
    let report = no_kmp_shared(&root);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

// ---- no-command-request ----

#[test]
fn a_command_request_on_the_wire_is_caught() {
    let root = fixture_dir("native-command-red");
    let proto = "crates/api-proto/proto/centraid/core/v1";
    write(
        &root,
        &format!("{proto}/command.proto"),
        "message Command {}\n",
    );
    write(
        &root,
        &format!("{proto}/envelope.proto"),
        "import \"centraid/core/v1/command.proto\";\nmessage Request {\n  oneof kind {\n    Command command = 5;\n  }\n}\n",
    );
    let report = no_command_request(&root);
    assert_eq!(report.findings.len(), 3, "{}", findings(&report));
    assert!(findings(&report).contains("envelope.proto:4"));
}

#[test]
fn an_envelope_without_a_command_arm_is_clean() {
    let root = fixture_dir("native-command-green");
    write(
        &root,
        "crates/api-proto/proto/centraid/core/v1/envelope.proto",
        "// the Command request was 5 (#1135)\nmessage Request {\n  reserved 5;\n  oneof kind {\n    Hello hello = 1;\n  }\n}\n",
    );
    let report = no_command_request(&root);
    assert!(matches!(report.state, RuleState::Applied(1)));
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

// ---- native-accessibility ----

fn accessible_tree(name: &str) -> std::path::PathBuf {
    let root = fixture_dir(name);
    for index in 0..4 {
        write(
            &root,
            &format!("mobile/androidApp/src/main/kotlin/K{index}.kt"),
            "fun k() { Icon(painter, contentDescription = label) }\n",
        );
    }
    for index in 0..3 {
        write(
            &root,
            &format!("mobile/iosApp/Sources/S{index}.swift"),
            "Image(systemName: \"x\")\n    .accessibilityHidden(true)\n",
        );
    }
    root
}

#[test]
fn an_unlabelled_icon_on_either_surface_is_caught() {
    let root = accessible_tree("native-a11y-red");
    write(
        &root,
        "mobile/androidApp/src/main/kotlin/Bad.kt",
        "fun bad() {\n    Icon(painter, contentDescription = null)\n}\nfun worse() { Image(painter) }\n",
    );
    write(
        &root,
        "mobile/iosApp/Sources/Bad.swift",
        "Button { } label: { Image(systemName: \"trash\") }\n",
    );
    let report = native_accessibility(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 3, "{text}");
    assert!(text.contains("Bad.kt: Image( with no contentDescription"));
    assert!(text.contains("Bad.kt:2: contentDescription = null without"));
    assert!(text.contains("Bad.swift: Image(systemName:)"));
}

#[test]
fn labelled_icons_and_a_decorative_null_are_clean_and_a_comment_is_not_code() {
    let root = accessible_tree("native-a11y-green");
    write(
        &root,
        "mobile/androidApp/src/main/kotlin/Ok.kt",
        "fun ok() {\n    // Image(painter) in a comment\n    CentraidIcon(key)\n    Icon(painter, contentDescription = null) // decorative: the label says it\n}\n",
    );
    write(
        &root,
        "mobile/iosApp/Design/Theme.swift",
        "Image(systemName: \"emitted\")\n",
    );
    let report = native_accessibility(&root);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

#[test]
fn a_lint_over_too_few_files_is_a_finding() {
    let root = fixture_dir("native-a11y-empty");
    write(&root, "mobile/iosApp/Sources/One.swift", "import SwiftUI\n");
    assert_eq!(native_accessibility(&root).findings.len(), 1);
}

// ---- no-tasks-namespace ----

#[test]
fn a_tasks_namespace_anywhere_on_the_phone_is_caught() {
    let root = fixture_dir("native-tasks-red");
    write(&root, "copy/tasks.json", "{}");
    write(
        &root,
        "mobile/androidApp/src/main/kotlin/dev/centraid/android/tasks/T.kt",
        "package dev.centraid.android.tasks\n",
    );
    write(
        &root,
        "mobile/core/src/commonMain/kotlin/A.kt",
        "val app = \"tasks\"\nconst val TASKS = 1\n",
    );
    write(
        &root,
        "mobile/iosApp/Sources/R.swift",
        "let route = \"tasks.home\"\n",
    );
    let report = no_tasks_namespace(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 6, "{text}");
    assert!(text.contains("copy/tasks.json"));
    assert!(text.contains("android/tasks: a `tasks` directory"));
    assert!(text.contains("T.kt:1"));
    assert!(text.contains("A.kt:1") && text.contains("A.kt:2"));
    assert!(text.contains("R.swift:1"));
}

#[test]
fn agenda_words_and_a_test_set_are_not_a_tasks_namespace() {
    let root = fixture_dir("native-tasks-green");
    write(
        &root,
        "mobile/core/src/commonMain/kotlin/A.kt",
        "// \"tasks\" left with #1128\nval board = tasks_board\nval tab = \"agenda.todo_list\"\n",
    );
    write(
        &root,
        "mobile/core/src/jvmTest/kotlin/TasksSpec.kt",
        "val app = \"tasks\"\n",
    );
    write(
        &root,
        "mobile/iosApp/Sources/R.swift",
        "let label = \"Tasks\"\n",
    );
    let report = no_tasks_namespace(&root);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

// ---- native-spells-no-screen-id ----

fn registry(root: &Path) {
    write(
        root,
        "crates/screens/src/agenda/mod.rs",
        "pub const HOME: &str = \"agenda.home\";\npub fn registry() -> Registry { Registry::default().with(HOME, home::build) }\n",
    );
    write(
        root,
        "crates/screens/src/backup/mod.rs",
        "pub fn registry() -> Registry { Registry::default().with(\"backup.home\", build) }\n",
    );
}

#[test]
fn a_shell_that_spells_a_screen_id_is_caught() {
    let root = fixture_dir("native-screen-id-red");
    registry(&root);
    write(
        &root,
        "mobile/iosApp/Sources/Shell.swift",
        "if route.screen == \"agenda.home\" { }\n",
    );
    write(
        &root,
        "mobile/androidApp/src/main/kotlin/Shell.kt",
        "when (screen) { \"backup.home\" -> Backup() }\n",
    );
    let report = native_spells_no_screen_id(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 2, "{text}");
    assert!(text.contains("Shell.swift:1: spells the screen id \"agenda.home\""));
    assert!(text.contains("Shell.kt:1"));
}

#[test]
fn a_shell_that_draws_the_route_it_was_given_is_clean() {
    let root = fixture_dir("native-screen-id-green");
    registry(&root);
    write(
        &root,
        "mobile/iosApp/Sources/Shell.swift",
        "// \"agenda.home\" is Rust's\nstore.push(row.route)\n",
    );
    let report = native_spells_no_screen_id(&root);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

// ---- native-names-no-command ----

#[test]
fn a_shell_that_names_a_vault_command_is_caught_and_a_test_may() {
    let root = fixture_dir("native-command-name");
    write(
        &root,
        "contracts/schema/vault-commands.txt",
        "note.create\nvault.rename\n",
    );
    write(
        &root,
        "mobile/iosApp/Sources/Notes.swift",
        "core.call(\"note.create\", input)\nlet utType = \"public.heic\"\n",
    );
    write(
        &root,
        "mobile/core/src/commonMain/kotlin/C.kt",
        "val c = \"vault.rename\"\n",
    );
    write(
        &root,
        "mobile/core/src/jvmTest/kotlin/RoundTrip.kt",
        "core.call(\"note.create\")\n",
    );
    let report = native_names_no_command(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 2, "{text}");
    assert!(text.contains("Notes.swift:1: names the vault command \"note.create\""));
    assert!(text.contains("C.kt:1"));
}

// ---- screens-per-app-layout ----

fn layout(root: &Path) {
    for owner in APPS.iter().copied().chain(["kit"]) {
        write(
            root,
            &format!("crates/screens/src/{owner}/mod.rs"),
            "use crate::kit::read;\n",
        );
    }
}

#[test]
fn an_app_reaching_into_another_or_the_kit_naming_an_app_is_caught() {
    let root = fixture_dir("native-layout-red");
    layout(&root);
    write(
        &root,
        "crates/screens/src/docs/drive.rs",
        "use crate::{\n    kit::read,\n    photos::routes,\n};\n",
    );
    write(
        &root,
        "crates/screens/src/kit/trash.rs",
        "fn back() -> Route { crate::notes::routes::home() }\n",
    );
    let report = screens_per_app_layout(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 2, "{text}");
    assert!(text.contains("docs/drive.rs:1: docs names crate::photos"));
    assert!(text.contains("kit/trash.rs:1: kit names crate::notes"));
}

#[test]
fn an_app_using_the_kit_the_shell_or_itself_is_clean() {
    let root = fixture_dir("native-layout-green");
    layout(&root);
    write(
        &root,
        "crates/screens/src/photos/picker.rs",
        "use crate::photos::routes;\nuse crate::{kit, strings::photos as words};\nconst TO: &str = crate::chat::HOME;\n// crate::docs in a comment\n",
    );
    let report = screens_per_app_layout(&root);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

// ---- healthkit-read-only ----

fn kinds(root: &Path) {
    write(
        root,
        "crates/screens/src/health/kinds.rs",
        "pub const TABLE: [(&str, &str); 3] = [\n    (\"running\", RUN),\n    (\"other\", OTHER),\n    (\"EXERCISE_TYPE_RUNNING\", RUN),\n];\n",
    );
}

fn healthkit_tree(name: &str, reader: &str) -> std::path::PathBuf {
    let root = fixture_dir(name);
    kinds(&root);
    write(
        &root,
        "mobile/iosApp/Sources/Health/HealthKitReader.swift",
        reader,
    );
    write(
        &root,
        "mobile/iosApp/Resources/Centraid.entitlements",
        "<dict>\n  <key>com.apple.developer.healthkit</key>\n  <true/>\n  <key>com.apple.developer.healthkit.access</key>\n  <array/>\n</dict>\n",
    );
    write(
        &root,
        "mobile/iosApp/project.yml",
        "# no NSHealthUpdateUsageDescription, and HealthSeeder is apart\n        com.apple.developer.healthkit.access: []\n",
    );
    write(
        &root,
        "mobile/iosApp/Resources/Info.plist",
        "<key>NSHealthShareUsageDescription</key>\n",
    );
    root
}

const GOOD_READER: &str = "import HealthKit\nfunc connect() { store.requestAuthorization(toShare: [], read: types) { _, _ in } }\nfunc word(_ type: HKWorkoutActivityType) -> String {\n    switch type {\n    case .running: return \"running\"\n    default: return \"other\"\n    }\n}\n";

#[test]
fn a_healthkit_reader_that_shares_nothing_is_clean() {
    let root = healthkit_tree("native-healthkit-green", GOOD_READER);
    let report = healthkit_read_only(&root);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

#[test]
fn a_healthkit_write_a_share_or_a_kind_off_the_table_is_caught() {
    let reader = "import HealthKit\nfunc connect() { store.requestAuthorization(toShare: [workout], read: types) { _, _ in } }\nfunc log() { store.save(sample) { _, _ in } }\nfunc word(_ type: HKWorkoutActivityType) -> String {\n    switch type {\n    case .running: return \"running\"\n    case .rowing: return \"rowing\"\n    default: return \"unknown\"\n    }\n}\n";
    let root = healthkit_tree("native-healthkit-red", reader);
    write(
        &root,
        "mobile/iosApp/Resources/Info.plist",
        "<key>NSHealthShareUsageDescription</key>\n<key>NSHealthUpdateUsageDescription</key>\n",
    );
    let report = healthkit_read_only(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 5, "{text}");
    for expected in [
        "toShare is not []",
        "(.save(",
        "Rust's kind table holds",
        "falls back to",
        "Info.plist declares",
    ] {
        assert!(text.contains(expected), "{expected} missing from\n{text}");
    }
}

// ---- health-connect-read-only ----

fn health_connect_tree(name: &str, reader: &str, manifest: &str) -> std::path::PathBuf {
    let root = fixture_dir(name);
    kinds(&root);
    let kit = "mobile/androidApp/src/main/kotlin/dev/centraid/android/kit";
    write(
        &root,
        "mobile/androidApp/src/main/AndroidManifest.xml",
        manifest,
    );
    write(&root, &format!("{kit}/HealthConnectReader.kt"), reader);
    write(
        &root,
        &format!("{kit}/ScreenEffects.kt"),
        "val sheet = launcher(reader.contract())\n",
    );
    for index in 0..50 {
        write(&root, &format!("{kit}/K{index}.kt"), "package kit\n");
    }
    for screen in ["Home", "Metric"] {
        write(
            &root,
            &format!(
                "mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/health/{screen}.kt"
            ),
            "package health\n",
        );
    }
    root
}

const READS: [&str; 6] = [
    "READ_STEPS",
    "READ_ACTIVE_CALORIES_BURNED",
    "READ_EXERCISE",
    "READ_SLEEP",
    "READ_RESTING_HEART_RATE",
    "READ_WEIGHT",
];

fn manifest(extra: &str) -> String {
    let mut text: String = READS
        .iter()
        .map(|read| {
            format!("<uses-permission android:name=\"android.permission.health.{read}\" />\n")
        })
        .collect();
    text.push_str(extra);
    text
}

fn reader(extra: &str) -> String {
    let mut text: String = READS
        .iter()
        .map(|read| format!("PREFIX + \"{read}\",\n"))
        .collect();
    text.push_str("fun contract() = createRequestPermissionResultContract()\n");
    text.push_str("val types = mapOf(ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to \"EXERCISE_TYPE_RUNNING\")\n");
    text.push_str(extra);
    text
}

#[test]
fn a_health_connect_reader_that_only_reads_is_clean() {
    let root = health_connect_tree("native-hc-green", &reader(""), &manifest(""));
    let report = health_connect_read_only(&root);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

#[test]
fn a_health_connect_write_a_write_permission_or_a_second_launcher_is_caught() {
    let root = health_connect_tree(
        "native-hc-red",
        &reader("suspend fun log() = client.insertRecords(listOf(record))\n"),
        &manifest("<uses-permission android:name=\"android.permission.health.WRITE_STEPS\" />\n"),
    );
    write(
        &root,
        "mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt",
        "val early = launcher(reader.contract())\n",
    );
    let report = health_connect_read_only(&root);
    let text = findings(&report);
    for expected in [
        "asks Health Connect for WRITE_STEPS",
        "insertRecords writes",
        "launched from",
    ] {
        assert!(text.contains(expected), "{expected} missing from\n{text}");
    }
}

// ---- walker-platform-law ----

#[test]
fn a_walker_refusal_holds_on_every_source_and_the_calls_pend_the_performer() {
    let root = fixture_dir("native-walker-pending");
    write(
        &root,
        "mobile/iosApp/Sources/Roll.swift",
        "options.isNetworkAccessAllowed = true\n",
    );
    write(
        &root,
        "mobile/androidApp/src/main/kotlin/Roll.kt",
        "val size = stream.available()\n",
    );
    let report = walker_platform_law(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 2, "{text}");
    assert!(
        report.note.contains("pend iOS and Android"),
        "{}",
        report.note
    );
}

#[test]
fn a_performer_missing_a_platform_call_is_caught() {
    let root = fixture_dir("native-walker-red");
    write(
        &root,
        "mobile/iosApp/Sources/Roll.swift",
        "case .rollPage(let page):\n    manager.requestData(for: resource, options: options)\n    // cancelDataRequest( in a comment is not the call\n",
    );
    let report = walker_platform_law(&root);
    let text = findings(&report);
    assert!(text.contains("iOS: no `cancelDataRequest(`"), "{text}");
    assert!(!text.contains("requestData(for:"), "{text}");
    assert!(report.note.contains("pend Android"), "{}", report.note);
}

// ---- first-launch-asks-nothing ----

#[test]
fn a_first_launch_view_that_asks_or_types_app_ids_is_caught() {
    let root = fixture_dir("native-first-launch-red");
    write(
        &root,
        "mobile/iosApp/Sources/FirstLaunchView.swift",
        "let apps = [\"photos\", \"docs\"]\nfunc go() { store.requestAuthorization(toShare: [], read: []) }\n",
    );
    let report = first_launch_asks_nothing(&root);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 2, "{text}");
    assert!(text.contains("requestAuthorization") && text.contains("\"photos\""));
}

#[test]
fn a_first_launch_view_that_draws_the_roster_is_clean_and_no_view_is_pending() {
    let root = fixture_dir("native-first-launch-green");
    write(
        &root,
        "mobile/iosApp/Sources/FirstLaunchView.swift",
        "ForEach(view.apps) { app in Tile(app) }\n",
    );
    assert!(first_launch_asks_nothing(&root).findings.is_empty());
    let empty = fixture_dir("native-first-launch-none");
    assert!(matches!(
        first_launch_asks_nothing(&empty).state,
        RuleState::Pending(_)
    ));
}
