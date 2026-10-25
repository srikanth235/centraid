//! The native shells' structural rules (#1135).
//!
//! The SwiftUI and Compose shells draw Rust's `ViewState` and perform generic
//! effects; neither compiles on the gate's machines (no Xcode, and the Android
//! build is an owner hand-off), so what must hold over their SOURCE is held
//! here, by scan, beside the four invariants in [`crate::rules`]. These were
//! Kotest specs in the deleted `mobile/shared` module's `jvmTest`
//! (`NativeAccessibilityLintSpec`, `NoTasksNamespaceSpec`,
//! `ShellRoutingStatedOnceSpec`, `ShellCommandsExistSpec`, `PerAppLayoutSpec`,
//! `HealthKitReadOnlySpec`, `HealthConnectReadOnlySpec`,
//! `WalkerPlatformLawSpec`, `FirstLaunchRosterSpec`'s view half); each keeps
//! its findings, repointed from the module's constants and paths to the Rust
//! source that now owns the fact and to the shells' real files. Two more
//! guard what the lane deleted: no `mobile/shared` and no `Command` request on
//! the wire can come back.
//!
//! Same discipline as [`crate::rules`]: hand-rolled scanners, every rule a
//! fixture that must be caught, and a rule whose subject is not in the tree
//! says PENDING rather than passing over nothing.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::rules::{RuleReport, relative, source_files};

/// Every native rule, in a stable order.
pub fn all(root: &Path) -> Vec<RuleReport> {
    vec![
        no_kmp_shared(root),
        no_command_request(root),
        native_accessibility(root),
        no_tasks_namespace(root),
        native_spells_no_screen_id(root),
        native_names_no_command(root),
        screens_per_app_layout(root),
        healthkit_read_only(root),
        health_connect_read_only(root),
        walker_platform_law(root),
        first_launch_asks_nothing(root),
    ]
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// The eight first-party apps (`crates/apps`). Chat is a tab, not an app.
const APPS: [&str; 8] = [
    "agenda", "docs", "health", "locker", "money", "notes", "people", "photos",
];

/// Files under `root/dir` with any of `extensions`, sorted.
fn files(root: &Path, dir: &str, extensions: &[&str]) -> Vec<PathBuf> {
    let base = root.join(dir);
    let mut out: Vec<PathBuf> = extensions
        .iter()
        .flat_map(|extension| source_files(&base, extension))
        .collect();
    out.sort();
    out
}

/// The SwiftUI shell's hand-written sources: `iosApp/Sources` without
/// protoc's `Generated/`.
fn swift_sources(root: &Path) -> Vec<PathBuf> {
    files(root, "mobile/iosApp/Sources", &["swift"])
        .into_iter()
        .filter(|path| !relative(root, path).contains("/Sources/Generated/"))
        .collect()
}

/// The Compose shell's production Kotlin.
fn compose_sources(root: &Path) -> Vec<PathBuf> {
    files(root, "mobile/androidApp/src/main", &["kt"])
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// The text with every `//` line comment cut, line by line. Crude on purpose
/// (a `//` inside a string is cut too), and the same cut the Kotest specs made.
fn without_line_comments(source: &str) -> String {
    source
        .lines()
        .map(|line| line.find("//").map_or(line, |at| &line[..at]))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Lines that are not comments, numbered from 1.
fn code_lines(source: &str) -> Vec<(usize, &str)> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*"))
        })
        .map(|(index, line)| (index + 1, line))
        .collect()
}

/// Up to `width` bytes of `text` from `start`, cut on a character boundary.
fn window(text: &str, start: usize, width: usize) -> &str {
    let mut end = (start + width).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[start..end]
}

/// Every byte offset where `needle` starts with no identifier byte before it.
fn calls(text: &str, needle: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(offset) = text.get(from..).and_then(|rest| rest.find(needle)) {
        let at = from + offset;
        let before = at.checked_sub(1).map(|prev| bytes[prev]);
        if !before.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
            out.push(at);
        }
        from = at + needle.len();
    }
    out
}

/// Every `"…"` literal on a line (no escapes inside a native id or key).
fn quoted(line: &str) -> Vec<&str> {
    line.split('"').skip(1).step_by(2).collect()
}

// ---------------------------------------------------------------------------
// The lane's own gates: what #1135 deleted stays deleted
// ---------------------------------------------------------------------------

/// `no-kmp-shared` — the Kotlin Multiplatform `:shared` module is gone and
/// nothing names it: no `mobile/shared`, no `include(":shared")`, no
/// `import CentraidShared`, no `dev.centraid.shared`, no `CentraidShared`
/// framework and no `:shared:` task in a build, workflow or script.
pub fn no_kmp_shared(root: &Path) -> RuleReport {
    const NAME: &str = "no-kmp-shared";
    if !root.join("mobile").is_dir() {
        return RuleReport::pending(NAME, "no mobile/ tree");
    }
    let mut findings = Vec::new();
    if root.join("mobile/shared").exists() {
        findings.push(
            "mobile/shared exists: the shells draw Rust's ViewState and the KMP session layer is deleted (#1135)"
                .to_owned(),
        );
    }
    let mut scanned = files(root, "mobile", &["kt", "kts", "swift", "yml", "yaml"]);
    scanned.extend(files(root, ".github", &["yml", "yaml"]));
    scanned.extend(files(root, "scripts", &["mjs", "js", "ts", "sh"]));
    // The module's own files are the one finding above, not a line each.
    scanned.retain(|path| !relative(root, path).starts_with("mobile/shared/"));
    for file in &scanned {
        let rel = relative(root, file);
        let source = read(file);
        let yaml = rel.ends_with(".yml") || rel.ends_with(".yaml") || rel.ends_with(".sh");
        for (number, line) in source.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//")
                || trimmed.starts_with('*')
                || trimmed.starts_with("/*")
                || (yaml && trimmed.starts_with('#'))
            {
                continue;
            }
            let what = if trimmed.starts_with("import CentraidShared") {
                Some("`import CentraidShared`")
            } else if line.contains("dev.centraid.shared") {
                Some("`dev.centraid.shared`")
            } else if line.contains("CentraidShared") {
                Some("the `CentraidShared` framework")
            } else if line.contains("\":shared\"") || line.contains(":shared:") {
                Some("the `:shared` Gradle module")
            } else {
                None
            };
            if let Some(what) = what {
                findings.push(format!(
                    "{rel}:{}: names {what}, which #1135 deleted",
                    number + 1
                ));
            }
        }
    }
    RuleReport::applied(NAME, scanned.len(), findings)
}

/// `no-command-request` — the shell asks the core through screens; there is no
/// `Command` request on the wire (#1135): no `command.proto`, no import of it
/// and no `Command` arm in `Request.kind`.
pub fn no_command_request(root: &Path) -> RuleReport {
    const NAME: &str = "no-command-request";
    let proto = root.join("crates/api-proto/proto/centraid/core/v1");
    if !proto.is_dir() {
        return RuleReport::pending(NAME, "no crates/api-proto/proto tree");
    }
    let mut findings = Vec::new();
    if proto.join("command.proto").exists() {
        findings.push(
            "crates/api-proto/proto/centraid/core/v1/command.proto exists: the FFI carries no Command request (#1135)"
                .to_owned(),
        );
    }
    let protos = source_files(&proto, "proto");
    for file in &protos {
        let rel = relative(root, file);
        for (line, text) in code_lines(&read(file)) {
            let code = text.trim();
            if code.contains("\"centraid/core/v1/command.proto\"") {
                findings.push(format!("{rel}:{line}: imports command.proto"));
            }
            let mut words = code.split_whitespace();
            if words.next() == Some("Command") && words.next() == Some("command") {
                findings.push(format!(
                    "{rel}:{line}: `{code}` is a Command arm; a write is a screen's `act` (#1135)"
                ));
            }
        }
    }
    RuleReport::applied(NAME, protos.len(), findings)
}

// ---------------------------------------------------------------------------
// The shells' sources
// ---------------------------------------------------------------------------

/// How far past a call site to look for its label: wide enough for a
/// multi-line argument list, narrow enough that the next control's label does
/// not satisfy this one (measured over code, comments cut).
const LABEL_WINDOW: usize = 320;

/// `native-accessibility` — an icon-only control carries a label on both
/// surfaces, and a decorative glyph says it is decorative (#1020, D-1020-E7).
pub fn native_accessibility(root: &Path) -> RuleReport {
    const NAME: &str = "native-accessibility";
    let compose = files(root, "mobile/androidApp/src", &["kt"]);
    let swift: Vec<PathBuf> = files(root, "mobile/iosApp", &["swift"])
        .into_iter()
        .filter(|path| {
            let rel = relative(root, path);
            !rel.contains("/Design/") && !rel.contains("/Sources/Generated/")
        })
        .collect();
    if compose.is_empty() && swift.is_empty() {
        return RuleReport::pending(NAME, "no native shell sources");
    }
    let mut findings = Vec::new();
    // AN EMPTY FILE SET IS A LINT THAT ALWAYS PASSES.
    if compose.len() < 4 || swift.len() < 3 {
        findings.push(format!(
            "the lint sees {} Compose and {} SwiftUI file(s); a lint over too few files passes forever",
            compose.len(),
            swift.len()
        ));
    }
    for file in &compose {
        let rel = relative(root, file);
        let source = read(file);
        let code = without_line_comments(&source);
        for needle in ["Icon(", "Image("] {
            for at in calls(&code, needle) {
                if !window(&code, at, LABEL_WINDOW).contains("contentDescription") {
                    findings.push(format!("{rel}: {needle} with no contentDescription"));
                }
            }
        }
        for (index, line) in source.lines().enumerate() {
            if line.contains("contentDescription = null") && !line.contains("// decorative") {
                findings.push(format!(
                    "{rel}:{}: contentDescription = null without a `// decorative` note",
                    index + 1
                ));
            }
        }
    }
    for file in &swift {
        let rel = relative(root, file);
        let code = without_line_comments(&read(file));
        for at in calls(&code, "Image(systemName:") {
            let near = window(&code, at, LABEL_WINDOW);
            if !near.contains(".accessibilityLabel(")
                && !near.contains(".accessibilityHidden(true)")
            {
                findings.push(format!(
                    "{rel}: Image(systemName:) with neither accessibilityLabel nor accessibilityHidden(true)"
                ));
            }
        }
    }
    RuleReport::applied(NAME, compose.len() + swift.len(), findings)
}

/// `no-tasks-namespace` — the tasks a member keeps are Agenda's (#1128,
/// #1135): no directory called `tasks` under a shell's sources, no `tasks`
/// app id or `tasks.` prefix in its production code, and no `tasks` copy
/// leaf. The Rust twin is `crates/core/src/catalog.rs`'s
/// `no_app_manifest_crate_or_query_namespace_is_called_tasks`.
pub fn no_tasks_namespace(root: &Path) -> RuleReport {
    const NAME: &str = "no-tasks-namespace";
    let mobile = root.join("mobile");
    if !mobile.is_dir() {
        return RuleReport::pending(NAME, "no mobile/ tree");
    }
    let mut findings = Vec::new();
    if root.join("copy/tasks.json").exists() {
        findings.push("copy/tasks.json exists: there is no tasks copy leaf".to_owned());
    }
    let mut trees: Vec<PathBuf> = fs::read_dir(&mobile)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path().join("src"))
                .filter(|src| src.is_dir())
                .collect()
        })
        .unwrap_or_default();
    trees.push(root.join("mobile/iosApp/Sources"));
    trees.sort();
    let mut directories = Vec::new();
    for tree in &trees {
        collect_directories(tree, &mut directories);
    }
    for directory in &directories {
        if directory
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("tasks"))
        {
            findings.push(format!(
                "{}: a `tasks` directory is the old app; the tasks are Agenda's",
                relative(root, directory)
            ));
        }
    }
    // Production source sets only: a test may assert the absence this polices.
    let sources: Vec<PathBuf> = trees
        .iter()
        .flat_map(|tree| {
            if tree.ends_with("Sources") {
                source_files(tree, "swift")
            } else {
                fs::read_dir(tree)
                    .map(|sets| {
                        sets.flatten()
                            .map(|set| set.path())
                            .filter(|set| {
                                set.is_dir()
                                    && !set.file_name().is_some_and(|name| {
                                        name.to_string_lossy().to_lowercase().contains("test")
                                    })
                            })
                            .flat_map(|set| source_files(&set, "kt"))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            }
        })
        .collect();
    if sources.is_empty() {
        findings
            .push("the scan sees no shell source; a check over nothing passes forever".to_owned());
    }
    for file in &sources {
        let rel = relative(root, file);
        for (line, text) in code_lines(&read(file)) {
            let code = text.trim();
            if tasks_namespace(code) {
                findings.push(format!(
                    "{rel}:{line}: {code} — the tasks are Agenda's: say `agenda`, route to `agenda.<screen>`"
                ));
            }
        }
    }
    RuleReport::applied(NAME, sources.len(), findings)
}

fn collect_directories(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if matches!(name.to_string_lossy().as_ref(), "build" | "Generated") {
                continue;
            }
            out.push(path.clone());
            collect_directories(&path, out);
        }
    }
}

/// `AppIds.TASKS`, `const val TASKS`, a `"tasks"` / `"tasks.…"` literal, or a
/// `dev.centraid.….tasks` package.
fn tasks_namespace(code: &str) -> bool {
    if crate::rules::word_at(code, "AppIds.TASKS") || code.contains("const val TASKS") {
        return true;
    }
    if code.contains("\"tasks\"") || code.contains("\"tasks.") {
        return true;
    }
    for prefix in ["package dev.centraid.", "import dev.centraid."] {
        if let Some(path) = code.strip_prefix(prefix)
            && path
                .split(|char: char| !(char.is_ascii_alphanumeric() || char == '_'))
                .any(|segment| segment == "tasks")
        {
            return true;
        }
    }
    false
}

/// Every screen id the Rust registries register (`Registry::with(ID, …)`),
/// resolved through the `const ID: &str = "…"` in the same file.
fn registered_screen_ids(root: &Path) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for file in source_files(&root.join("crates/screens/src"), "rs") {
        let source = read(&file);
        let mut consts = std::collections::BTreeMap::new();
        for line in source.lines() {
            let trimmed = line
                .trim_start()
                .trim_start_matches("pub ")
                .trim_start_matches("pub(crate) ");
            if let Some(rest) = trimmed.strip_prefix("const ")
                && let Some((name, value)) = rest.split_once(": &str = \"")
                && let Some(value) = value.strip_suffix("\";")
            {
                consts.insert(name.trim().to_owned(), value.to_owned());
            }
        }
        for at in calls(&source, ".with(") {
            let argument = source[at + ".with(".len()..]
                .trim_start()
                .split(',')
                .next()
                .unwrap_or_default()
                .trim();
            if let Some(literal) = argument
                .strip_prefix('"')
                .and_then(|rest| rest.strip_suffix('"'))
            {
                ids.insert(literal.to_owned());
            } else if let Some(value) = consts.get(argument) {
                ids.insert(value.clone());
            }
        }
    }
    ids.retain(|id| id.contains('.'));
    ids
}

/// `native-spells-no-screen-id` — a screen id is Rust's (`Registry::with`);
/// the shells draw a `Route` they were given and never spell a destination
/// (docs/screens.md "Conventions"). Was `ShellRoutingStatedOnceSpec`, whose
/// constants were the KMP module's.
pub fn native_spells_no_screen_id(root: &Path) -> RuleReport {
    const NAME: &str = "native-spells-no-screen-id";
    let ids = registered_screen_ids(root);
    if ids.is_empty() {
        return RuleReport::pending(NAME, "no Rust screen registry under crates/screens/src");
    }
    let mut sources = swift_sources(root);
    sources.extend(compose_sources(root));
    let mut findings = Vec::new();
    if !ids.contains("agenda.home") || !ids.contains("backup.home") {
        findings.push(format!(
            "the registry scan read {} id(s) and missed agenda.home or backup.home; it stopped reading `Registry::with`",
            ids.len()
        ));
    }
    for file in &sources {
        let rel = relative(root, file);
        for (line, text) in code_lines(&read(file)) {
            for literal in quoted(text) {
                if ids.contains(literal) {
                    findings.push(format!(
                        "{rel}:{line}: spells the screen id \"{literal}\"; a shell pushes the `Route` Rust put in the view"
                    ));
                }
            }
        }
    }
    RuleReport::applied(NAME, sources.len(), findings)
        .with_note(format!(" ({} registered screen id(s))", ids.len()))
}

/// `native-names-no-command` — a write is a Rust screen's `act` through the
/// generated catalogue; no shell's production source names a vault command
/// (`contracts/schema/vault-commands.txt`, which `crates/vault/tests/
/// command_list.rs` keeps equal to the registry). Was
/// `ShellCommandsExistSpec`, which held the KMP module's command literals to
/// the same registry.
pub fn native_names_no_command(root: &Path) -> RuleReport {
    const NAME: &str = "native-names-no-command";
    let registry = read(&root.join("contracts/schema/vault-commands.txt"));
    let commands: BTreeSet<&str> = registry
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if commands.is_empty() {
        return RuleReport::pending(NAME, "no contracts/schema/vault-commands.txt");
    }
    let mut sources = swift_sources(root);
    sources.extend(compose_sources(root));
    if let Ok(sets) = fs::read_dir(root.join("mobile/core/src")) {
        for set in sets.flatten() {
            let name = set.file_name().to_string_lossy().to_string();
            if name.ends_with("Main") {
                sources.extend(source_files(&set.path(), "kt"));
            }
        }
    }
    sources.sort();
    let mut findings = Vec::new();
    for file in &sources {
        let rel = relative(root, file);
        for (line, text) in code_lines(&read(file)) {
            for literal in quoted(text) {
                if commands.contains(literal) {
                    findings.push(format!(
                        "{rel}:{line}: names the vault command \"{literal}\"; the shell sends no command, a Rust screen acts"
                    ));
                }
            }
        }
    }
    RuleReport::applied(NAME, sources.len(), findings)
        .with_note(format!(" ({} registered command(s))", commands.len()))
}

/// `screens-per-app-layout` — one folder per app under `crates/screens/src`,
/// self-contained: an app's screens name no other app's module, and the kit
/// names no app (docs/screens.md "Writing a screen"; #1025 S5, D-1025-S5-1).
/// Was `PerAppLayoutSpec` over the KMP packages.
pub fn screens_per_app_layout(root: &Path) -> RuleReport {
    const NAME: &str = "screens-per-app-layout";
    let src = root.join("crates/screens/src");
    if !src.is_dir() {
        return RuleReport::pending(NAME, "no crates/screens/src");
    }
    let mut findings = Vec::new();
    let mut scanned = 0usize;
    for owner in APPS.iter().copied().chain(["kit"]) {
        let dir = src.join(owner);
        if !dir.is_dir() {
            findings.push(format!(
                "crates/screens/src/{owner} is missing; the layout this rule is about moved"
            ));
            continue;
        }
        for file in source_files(&dir, "rs") {
            scanned += 1;
            let rel = relative(root, &file);
            for (line, app) in crate_paths(&read(&file)) {
                if app != owner && APPS.contains(&app.as_str()) {
                    findings.push(format!(
                        "{rel}:{line}: {owner} names crate::{app}; apps meet in the vault, never in a screen"
                    ));
                }
            }
        }
    }
    RuleReport::applied(NAME, scanned, findings)
}

/// The first segment of every `crate::<x>` path, and of every top-level name in
/// a `use crate::{…}` group, with its line.
fn crate_paths(source: &str) -> Vec<(usize, String)> {
    let code = without_line_comments(source);
    let line_of = |at: usize| code[..at].matches('\n').count() + 1;
    let ident = |text: &str| -> String {
        text.chars()
            .take_while(|char| char.is_ascii_alphanumeric() || *char == '_')
            .collect()
    };
    let mut out = Vec::new();
    for at in calls(&code, "crate::") {
        let rest = &code[at + "crate::".len()..];
        if let Some(group) = rest.strip_prefix('{') {
            let mut depth = 1usize;
            let mut token_start = true;
            for (offset, char) in group.char_indices() {
                match char {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    ',' if depth == 1 => token_start = true,
                    char if char.is_whitespace() => {}
                    _ if token_start && depth == 1 => {
                        token_start = false;
                        let name = ident(&group[offset..]);
                        if !name.is_empty() {
                            out.push((line_of(at), name));
                        }
                    }
                    _ => {}
                }
            }
        } else {
            let name = ident(rest);
            if !name.is_empty() {
                out.push((line_of(at), name));
            }
        }
    }
    out
}

/// The store words the Rust kind table maps (`crates/screens/src/health/
/// kinds.rs`'s `TABLE` left column).
fn kind_words(root: &Path) -> BTreeSet<String> {
    let text = read(&root.join("crates/screens/src/health/kinds.rs"));
    let table = text
        .split("pub const TABLE")
        .nth(1)
        .and_then(|rest| rest.split("];").next())
        .unwrap_or_default();
    table
        .split("(\"")
        .skip(1)
        .filter_map(|entry| {
            let (word, rest) = entry.split_once('"')?;
            let kind = rest.trim_start().strip_prefix(',')?.trim_start();
            kind.starts_with(|char: char| char.is_ascii_uppercase())
                .then(|| word.to_owned())
        })
        .collect()
}

/// `healthkit-read-only` — nothing is written to Apple Health (#1129,
/// R-1129-7): every `requestAuthorization` shares nothing, nothing saves,
/// deletes or builds a HealthKit object, the entitlement's access list is
/// empty, no write reason is declared, and the reader's workout kinds are
/// the kind table's HealthKit words.
pub fn healthkit_read_only(root: &Path) -> RuleReport {
    const NAME: &str = "healthkit-read-only";
    let ios = root.join("mobile/iosApp");
    if !ios.is_dir() {
        return RuleReport::pending(NAME, "no mobile/iosApp");
    }
    let sources = swift_sources(root);
    let mut findings = Vec::new();
    let mut asks = 0usize;
    let mut reader = None;
    for file in &sources {
        let rel = relative(root, file);
        let source = read(file);
        if !source.lines().any(|line| line.trim() == "import HealthKit") {
            continue;
        }
        let code = without_line_comments(&source);
        if rel.ends_with("/HealthKitReader.swift") {
            reader = Some(code.clone());
        }
        for at in calls(&code, "requestAuthorization(") {
            asks += 1;
            let arguments = window(&code, at, 400).split(')').next().unwrap_or_default();
            let shares_nothing = arguments
                .split("toShare:")
                .nth(1)
                .is_some_and(|rest| rest.trim_start().starts_with("[]"));
            if !shares_nothing {
                findings.push(format!(
                    "{rel}: requestAuthorization whose toShare is not []"
                ));
            }
        }
        for write in [
            ".save(",
            ".delete(",
            ".deleteObjects(",
            ".deleteObject(",
            "HKWorkoutBuilder",
            "HKQuantitySample(",
            "HKCategorySample(",
            "HKWorkout(",
        ] {
            if code.contains(write) {
                findings.push(format!("{rel}: a HealthKit write in the app ({write})"));
            }
        }
    }
    if asks != 1 {
        findings.push(format!(
            "{asks} HealthKit requestAuthorization call(s) in Sources/; there is one, at Connect"
        ));
    }
    match reader {
        None => findings.push(
            "Sources/Health/HealthKitReader.swift is missing or imports no HealthKit".to_owned(),
        ),
        Some(reader) => {
            let mut named = BTreeSet::new();
            let mut fallback = None;
            for line in reader.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("case .") {
                    if let Some((_, word)) = rest.split_once(": return \"") {
                        named.insert(word.trim_end_matches('"').to_owned());
                    }
                } else if let Some(word) = line.strip_prefix("default: return \"") {
                    fallback = Some(word.trim_end_matches('"').to_owned());
                }
            }
            let mut table: BTreeSet<String> = kind_words(root)
                .into_iter()
                .filter(|word| !word.starts_with("EXERCISE_TYPE_"))
                .collect();
            table.remove("other");
            if named != table {
                findings.push(format!(
                    "HealthKitReader.swift names {named:?}; Rust's kind table holds {table:?}"
                ));
            }
            if fallback.as_deref() != Some("other") {
                findings.push(format!(
                    "HealthKitReader.swift falls back to {fallback:?}, not \"other\""
                ));
            }
        }
    }
    let entitlements = read(&ios.join("Resources/Centraid.entitlements"));
    let squashed: String = entitlements.split_whitespace().collect();
    if !squashed.contains("<key>com.apple.developer.healthkit</key><true/>") {
        findings.push("Resources/Centraid.entitlements does not carry HealthKit".to_owned());
    }
    if !squashed.contains("<key>com.apple.developer.healthkit.access</key><array/>") {
        findings
            .push("Resources/Centraid.entitlements' HealthKit access list is not empty".to_owned());
    }
    let project = read(&ios.join("project.yml"));
    let yaml: Vec<&str> = project
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect();
    if !yaml
        .iter()
        .any(|line| line.trim() == "com.apple.developer.healthkit.access: []")
    {
        findings.push("project.yml's HealthKit access list is not `[]`".to_owned());
    }
    if yaml
        .iter()
        .any(|line| line.contains("NSHealthUpdateUsageDescription"))
    {
        findings.push("project.yml declares a reason to write to Health".to_owned());
    }
    if yaml.iter().any(|line| line.contains("HealthSeeder")) {
        findings.push("project.yml names the seeder outside a comment".to_owned());
    }
    let plist = read(&ios.join("Resources/Info.plist"));
    if plist.contains("NSHealthUpdateUsageDescription") {
        findings.push("Info.plist declares a reason to write to Health".to_owned());
    }
    if !plist.contains("NSHealthShareUsageDescription") {
        findings.push("Info.plist names no reason Health reads".to_owned());
    }
    RuleReport::applied(NAME, sources.len() + 3, findings)
}

/// `health-connect-read-only` — nothing is written to Health Connect, and the
/// OS is asked only at Connect (#1129, R-1129-7, R-1127-15).
pub fn health_connect_read_only(root: &Path) -> RuleReport {
    const NAME: &str = "health-connect-read-only";
    let app = root.join("mobile/androidApp/src/main");
    if !app.is_dir() {
        return RuleReport::pending(NAME, "no mobile/androidApp/src/main");
    }
    let manifest = read(&app.join("AndroidManifest.xml"));
    let kit = "mobile/androidApp/src/main/kotlin/dev/centraid/android/kit";
    let reader_path = format!("{kit}/HealthConnectReader.kt");
    let act_path = format!("{kit}/ScreenEffects.kt");
    let reader = read(&root.join(&reader_path));
    let sources = files(root, "mobile/androidApp/src", &["kt"]);
    let mut findings = Vec::new();
    if manifest.is_empty()
        || reader.is_empty()
        || !root.join(&act_path).is_file()
        || sources.len() <= 50
    {
        findings.push(format!(
            "the scan reads the manifest, {reader_path}, {act_path} and {} Kotlin file(s); a check over nothing passes forever",
            sources.len()
        ));
    }
    let declared: BTreeSet<String> = manifest
        .split("android.permission.health.")
        .skip(1)
        .map(|rest| {
            rest.chars()
                .take_while(|char| char.is_ascii_uppercase() || *char == '_')
                .collect()
        })
        .collect();
    for permission in &declared {
        if !permission.starts_with("READ_") {
            findings.push(format!(
                "AndroidManifest.xml asks Health Connect for {permission}"
            ));
        }
    }
    for needed in [
        "READ_STEPS",
        "READ_ACTIVE_CALORIES_BURNED",
        "READ_EXERCISE",
        "READ_SLEEP",
        "READ_RESTING_HEART_RATE",
        "READ_WEIGHT",
    ] {
        if !declared.contains(needed) {
            findings.push(format!("AndroidManifest.xml does not declare {needed}"));
        }
    }
    let asked: Vec<String> = reader
        .split("PREFIX + \"")
        .skip(1)
        .filter_map(|rest| rest.split_once('"').map(|(word, _)| word.to_owned()))
        .collect();
    if asked.len() < 6 {
        findings.push(format!(
            "{reader_path} asks for {} permission(s); the scan stopped reading it",
            asked.len()
        ));
    }
    for permission in &asked {
        if !permission.starts_with("READ_") {
            findings.push(format!("{reader_path} asks for {permission}"));
        }
        if !manifest.contains(&format!("android.permission.health.{permission}\"")) {
            findings.push(format!(
                "{reader_path} asks for {permission}, which the manifest does not declare"
            ));
        }
    }
    let mut health_files = 0usize;
    let mut builds = Vec::new();
    let mut launches = Vec::new();
    for file in &sources {
        let rel = relative(root, file);
        let source = read(file);
        for write in [
            "insertRecords",
            "updateRecords",
            "deleteRecords",
            "upsertMedicalResources",
            "getWritePermission",
        ] {
            if crate::rules::word_at(&source, write) {
                findings.push(format!("{rel}: {write} writes to Health Connect"));
            }
        }
        if rel == reader_path || rel.contains("/screens/health/") {
            health_files += 1;
            if source.contains("WRITE_") {
                findings.push(format!("{rel}: names a Health Connect WRITE_ permission"));
            }
        }
        if source.contains("createRequestPermissionResultContract") {
            builds.push(rel.clone());
        }
        if rel != reader_path && source.contains(".contract()") {
            launches.push(rel);
        }
    }
    if health_files < 3 {
        findings.push(format!("{health_files} Health file(s) scanned for a write permission; expected the reader and screens/health"));
    }
    if builds != [reader_path.clone()] {
        findings.push(format!(
            "the permission sheet is built in {builds:?}; only {reader_path} builds it"
        ));
    }
    if launches != [act_path.clone()] {
        findings.push(format!(
            "the permission sheet is launched from {launches:?}; only {act_path} launches it"
        ));
    }
    let mut named = BTreeSet::new();
    for pair in reader.split("ExerciseSessionRecord.").skip(1) {
        let constant: String = pair
            .chars()
            .take_while(|char| char.is_ascii_uppercase() || *char == '_')
            .collect();
        if let Some(word) = pair[constant.len()..]
            .strip_prefix(" to \"")
            .and_then(|rest| rest.split_once('"'))
            .map(|(word, _)| word.to_owned())
        {
            if word != constant {
                findings.push(format!("{reader_path}: {constant} is named \"{word}\""));
            }
            named.insert(word);
        }
    }
    for word in kind_words(root) {
        if word.starts_with("EXERCISE_TYPE_") && !named.contains(&word) {
            findings.push(format!(
                "{reader_path} does not name {word}, which Rust's kind table maps"
            ));
        }
    }
    RuleReport::applied(NAME, sources.len() + 1, findings)
}

/// `walker-platform-law` — the camera-roll walker's platform facts (#1080, the
/// walker; R-1127-4, R-1127-5; D-1025-S7-77). What a walk DOES with the
/// answers is Rust's (`crates/screens/tests/imports_camera_roll.rs`); what the
/// shell's performer of `RollPage`/`LibraryStage`/`LibraryDerivatives` must
/// and must never do is held here. The refusals hold on every source; the
/// platform calls a performer must make are held once the shell performs
/// `RollPage`.
pub fn walker_platform_law(root: &Path) -> RuleReport {
    const NAME: &str = "walker-platform-law";
    let swift = swift_sources(root);
    let compose = compose_sources(root);
    if swift.is_empty() && compose.is_empty() {
        return RuleReport::pending(NAME, "no native shell sources");
    }
    let code = |paths: &[PathBuf]| -> String {
        paths
            .iter()
            .map(|path| {
                read(path)
                    .lines()
                    .map(|line| line.find("//").map_or(line, |at| &line[..at]))
                    .filter(|line| !line.trim_start().starts_with('*'))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let ios = code(&swift);
    let android = code(&compose);
    let mut findings = Vec::new();
    let mut refuse = |text: &str, platform: &str, needle: &str, why: &str| {
        if text.contains(needle) {
            findings.push(format!("{platform}: `{needle}` — {why}"));
        }
    };
    refuse(
        &ios,
        "iOS",
        "writeData(for:",
        "a temporary copy of a library original",
    );
    refuse(
        &ios,
        "iOS",
        "centraid-stage-",
        "a temporary copy of a library original",
    );
    refuse(
        &ios,
        "iOS",
        "isNetworkAccessAllowed = true",
        "an iCloud download hard-coded on",
    );
    refuse(
        &ios,
        "iOS",
        "deletedLocalIdentifiers",
        "a deletion from the library read as news for the vault (R-1127-4)",
    );
    refuse(
        &ios,
        "iOS",
        "\"OffsetTime\"",
        "the file's last-change zone read in place of the shutter's (D-1025-S7-77)",
    );
    refuse(
        &android,
        "Android",
        "TAG_OFFSET_TIME)",
        "the file's last-change zone read in place of the shutter's (D-1025-S7-77)",
    );
    refuse(
        &android,
        "Android",
        ".available()",
        "a length guessed from what reads without blocking; size from the descriptor",
    );
    refuse(
        &android,
        "Android",
        "ASC LIMIT",
        "Android 11 refuses LIMIT in a MediaStore sort order",
    );
    for (text, platform) in [(&ios, "iOS"), (&android, "Android")] {
        refuse(
            text,
            platform,
            "capturedUtcOffsetMinutes = 0",
            "an asset described with a hard-coded zero offset",
        );
        refuse(
            text,
            platform,
            "captured_utc_offset_minutes = 0",
            "an asset described with a hard-coded zero offset",
        );
        refuse(
            text,
            platform,
            "osEdited",
            "an edited asset marked at the stage door",
        );
    }
    let performs = |text: &str| {
        text.contains("rollPage") || text.contains("RollPage") || text.contains("roll_page")
    };
    let mut pending = Vec::new();
    let mut require =
        |text: &str, platform: &str, needles: &[(&str, &str)], findings: &mut Vec<String>| {
            if !performs(text) {
                pending.push(platform.to_owned());
                return;
            }
            for (needle, why) in needles {
                if !text.contains(needle) {
                    findings.push(format!("{platform}: no `{needle}` — {why}"));
                }
            }
        };
    require(
        &ios,
        "iOS",
        &[
            (
                "requestData(for:",
                "a resource streams straight out of Photos, with no copy",
            ),
            (
                "cancelDataRequest(",
                "a stage that refused half way lets go of the Photos request",
            ),
            (
                "isNetworkAccessAllowed = ",
                "iCloud is reached only when the walker says it may",
            ),
            (
                "hasAdjustments",
                "an edited asset stages its current rendition",
            ),
            (
                "modificationDate",
                "an edit's ref names the version it was read at",
            ),
            (
                "fetchPersistentChanges(since:",
                "additions are found by the persistent change token",
            ),
            (
                "insertedLocalIdentifiers",
                "additions are found by the persistent change token",
            ),
            (
                "updatedLocalIdentifiers",
                "an edit made in Photos is an updated asset",
            ),
            ("currentChangeToken", "the next walk starts from the token"),
            (
                "OffsetTimeOriginal",
                "the capture's offset is the shutter's EXIF tag",
            ),
            (
                "PHContentEditingInputRequestOptions",
                "the offset is read through Photos' own URL",
            ),
            (
                "requestImage(for:",
                "the derivatives are drawn by the platform",
            ),
        ],
        &mut findings,
    );
    require(
        &android,
        "Android",
        &[
            (
                "MediaStore.Files.getContentUri(",
                "photographs and videos are walked together",
            ),
            ("MEDIA_TYPE_IMAGE", "photographs are walked"),
            ("MEDIA_TYPE_VIDEO", "videos are walked"),
            (
                "MediaStore.MediaColumns.DATE_MODIFIED",
                "an item edited in place is found by its DATE_MODIFIED",
            ),
            ("statSize", "the size comes from the descriptor"),
            (
                "MediaStore.setRequireOriginal(",
                "the camera's location is kept in the backed-up bytes",
            ),
            (
                "TAG_OFFSET_TIME_ORIGINAL",
                "the capture's offset is the shutter's EXIF tag",
            ),
            (
                "loadThumbnail(",
                "the derivatives are drawn by the platform",
            ),
        ],
        &mut findings,
    );
    let note = if pending.is_empty() {
        String::new()
    } else {
        format!(
            " (the performer's calls pend {}: no RollPage performer yet)",
            pending.join(" and ")
        )
    };
    RuleReport::applied(NAME, swift.len() + compose.len(), findings).with_note(note)
}

/// `first-launch-asks-nothing` — the first-launch gate lists Home's roster
/// without typing app ids, and asks the phone for nothing: Health asks on its
/// own Connect button (#1129, R-1127-15). The roster itself is Rust's ORDER,
/// held to the catalogue by `packages/design/src/native-emission.test.ts`.
pub fn first_launch_asks_nothing(root: &Path) -> RuleReport {
    const NAME: &str = "first-launch-asks-nothing";
    let mut views: Vec<PathBuf> = swift_sources(root)
        .into_iter()
        .filter(|path| path.ends_with("FirstLaunchView.swift"))
        .collect();
    views.extend(
        compose_sources(root)
            .into_iter()
            .filter(|path| path.ends_with("FirstLaunchScreen.kt")),
    );
    if views.is_empty() {
        return RuleReport::pending(NAME, "no native first-launch view");
    }
    let mut findings = Vec::new();
    for file in &views {
        let rel = relative(root, file);
        let source = read(file);
        for ask in [
            "requestAuthorization",
            "HKHealthStore",
            "HealthConnect",
            "PermissionController",
            "CNContactStore",
            "EKEventStore",
            "Manifest.permission",
            "rememberLauncherForActivityResult",
        ] {
            if source.contains(ask) {
                findings.push(format!(
                    "{rel}: `{ask}` — the gate asks the phone for nothing"
                ));
            }
        }
        let squashed: String = source.split_whitespace().collect();
        for opener in ["[", "listOf(", "arrayOf("] {
            for app in APPS.iter().copied().chain(["tasks"]) {
                if squashed.contains(&format!("{opener}\"{app}\"")) {
                    findings.push(format!(
                        "{rel}: types the app id \"{app}\" into a list; the house is Home's roster"
                    ));
                }
            }
        }
    }
    RuleReport::applied(NAME, views.len(), findings)
}

#[cfg(test)]
#[path = "native_rules_tests.rs"]
mod tests;
