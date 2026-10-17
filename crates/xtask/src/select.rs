//! Which crates the `local` profile's `test` step runs (hand-off 6.5, the
//! owner's ruling of 2026-10-15).
//!
//! `cargo xtask gate --profile local` ran `cargo nextest run --workspace` over
//! every crate on every edit, and that one step was almost all of a loop that
//! took 290 to 500 s against a 120 s budget. The ruling: the loop tests the
//! crates a change **touches, plus the crates that depend on them**, and `pr`
//! (which CI runs on every pull request) keeps the whole workspace. This module
//! decides which crates those are. It decides nothing else: `fmt`, `clippy`,
//! `restore-drill`, `rules`, `doc-links` and `ledgers` still run over the whole
//! tree, and `pr`, `nightly`, `release` and `mobile-jvm` never call it.
//!
//! ## What "changed" means
//!
//! The files that differ between the working tree and the merge base with the
//! default branch (`origin/main`, then `main` — the same candidates the
//! `ledgers` step compares against), so committed, staged, unstaged and
//! untracked work all count. `CENTRAID_GATE_BASE` names a different commit, or
//! a tree, to diff against. With **no base at all** the run falls back to the
//! whole workspace: narrowing against nothing would be a guess, and the failure
//! direction of a wrong guess is a green loop over code nobody ran.
//!
//! ## What a changed path selects
//!
//! In this order, the first rule that matches wins:
//!
//! 1. **A workspace-wide input** — the root `Cargo.toml` or `Cargo.lock`, the
//!    toolchain pin, `.cargo/`, `.config/`, `crates/xtask/` (the runner's code,
//!    which also decides this selection), or **any** `Cargo.toml`: a member's
//!    manifest can move a feature on a crate that does not depend on it,
//!    because one `--workspace` build unifies features across every member.
//!    The whole workspace runs.
//! 2. **A path inside a member's directory** selects that member.
//! 3. **A path some member reads from outside its own directory** — the
//!    fixtures under `contracts/`, the generated `copy/` and `design/`, a
//!    Swift file the assistant embeds — selects the members whose sources name
//!    it. Those are *derived*, by [`scan_reads`], not listed here: a table of
//!    "crate X reads tree Y" is a second copy of facts the code already states,
//!    and a copy rots in the direction that skips tests.
//! 4. **Anything else** — documentation, receipts, scripts, workflows, the
//!    mobile shells — is read by no crate and selects nothing.
//!
//! Then every selected member pulls in the members that depend on it, through
//! Cargo (every dependency kind, so a dev-dependency counts) and through a
//! source that `include_str!`s another member's file.
//!
//! ## What it deliberately does not do
//!
//! It does not change how the tests are built. The narrowed run is still
//! `cargo nextest run --workspace`, with a filter expression: `-p` would
//! resolve features for the chosen crates alone, which is not the feature set
//! the `restore-drill` and `clippy` steps build under, and alternating the two
//! costs a rebuild of most of the dependency graph each way (measured at 162 to
//! 186 s, `crates/xtask/README.md`). The saving is in what runs, and on a tree
//! that is already built, what runs is the whole of the step.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::ledger;

/// Names a commit or tree to diff against instead of the merge base.
pub const BASE_ENV: &str = "CENTRAID_GATE_BASE";

/// `all` runs the whole workspace on the `local` profile, as `pr` does.
pub const TESTS_ENV: &str = "CENTRAID_GATE_TESTS";

/// One workspace member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub name: String,
    /// Repository-relative, `/`-separated, no trailing slash.
    pub dir: String,
    /// The workspace members this one depends on, through any dependency kind.
    pub deps: BTreeSet<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Workspace {
    pub members: Vec<Member>,
}

/// What the members' sources name outside their own directories.
#[derive(Debug, Clone, Default)]
pub struct Reads {
    /// member → the directories (or root-level files) outside every member that
    /// its sources name.
    pub dirs: BTreeMap<String, BTreeSet<String>>,
    /// `(reader, source)`: the reader's sources name a file inside `source`'s
    /// directory, so `source` changing can change what `reader` does.
    pub includes: BTreeSet<(String, String)>,
}

/// The files that changed, and what they changed against.
#[derive(Debug, Clone)]
pub struct Changes {
    /// A short description of the base, for the evidence line.
    pub base: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Every member, and the reasons the narrowing could not hold.
    Whole(Vec<String>),
    /// These members, each with why it is in. Empty means nothing to test.
    Crates(Vec<(String, String)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub scope: Scope,
    /// How many members the workspace has.
    pub total: usize,
    pub base: String,
    pub changed: usize,
}

impl Plan {
    fn whole(total: usize, base: &str, changed: usize, reasons: Vec<String>) -> Self {
        Self {
            scope: Scope::Whole(reasons),
            total,
            base: base.to_owned(),
            changed,
        }
    }

    /// True when the run is narrower than `pr`'s.
    pub fn narrowed(&self) -> bool {
        match &self.scope {
            Scope::Whole(_) => false,
            Scope::Crates(selected) => selected.len() < self.total,
        }
    }

    pub fn selected(&self) -> Vec<&str> {
        match &self.scope {
            Scope::Whole(_) => Vec::new(),
            Scope::Crates(selected) => selected.iter().map(|(name, _)| name.as_str()).collect(),
        }
    }

    /// The loud block printed before the step's one line, and written beside
    /// the failure artifacts. Says which crates ran and why, and — because a
    /// narrowed loop is the thing a reader must not mistake for `pr` — what the
    /// run did NOT cover.
    pub fn describe(&self) -> String {
        let base = &self.base;
        match &self.scope {
            Scope::Whole(reasons) => {
                let mut out = format!(
                    "test: WHOLE WORKSPACE, {n} of {n} crate(s) — not narrowed, because:\n",
                    n = self.total
                );
                for reason in reasons {
                    out.push_str(&format!("  - {reason}\n"));
                }
                out
            }
            Scope::Crates(selected) if selected.is_empty() => format!(
                "test: NARROWED to 0 of {total} crate(s) — {changed} file(s) changed since {base}, and none is inside a crate, read by one, or an input every crate shares.\n  \
                 No Rust test ran. `cargo xtask gate --profile pr` runs all {total}; CENTRAID_GATE_TESTS=all widens this profile.\n",
                total = self.total,
                changed = self.changed,
            ),
            Scope::Crates(selected) if selected.len() >= self.total => format!(
                "test: WHOLE WORKSPACE, {total} of {total} crate(s) — the {changed} file(s) changed since {base} reach every crate, so nothing is left out.\n",
                total = self.total,
                changed = self.changed,
            ),
            Scope::Crates(selected) => {
                let mut out = format!(
                    "test: NARROWED to {n} of {total} crate(s) — {changed} file(s) changed since {base}.\n  \
                     The other {rest} crate(s) did not run; `cargo xtask gate --profile pr` runs all {total}, and CENTRAID_GATE_TESTS=all widens this profile.\n",
                    n = selected.len(),
                    total = self.total,
                    changed = self.changed,
                    rest = self.total - selected.len(),
                );
                for (name, why) in selected {
                    out.push_str(&format!("    {name:<28} {why}\n"));
                }
                out
            }
        }
    }

    /// The nextest filter expression naming the selected crates by exact
    /// package name. `None` when nothing is narrowed.
    pub fn filterset(&self) -> Option<String> {
        if !self.narrowed() {
            return None;
        }
        let names = self.selected();
        if names.is_empty() {
            return None;
        }
        Some(
            names
                .iter()
                .map(|name| format!("package(={name})"))
                .collect::<Vec<_>>()
                .join(" | "),
        )
    }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/// Why a path forces the whole workspace, if it does.
pub fn workspace_wide(path: &str) -> Option<&'static str> {
    match path {
        "Cargo.toml" | "Cargo.lock" => return Some("the workspace manifest or lockfile"),
        "rust-toolchain" | "rust-toolchain.toml" => return Some("the toolchain pin"),
        _ => {}
    }
    if path.starts_with(".cargo/") {
        return Some("the cargo configuration");
    }
    if path.starts_with(".config/") {
        return Some("the test runner's configuration");
    }
    // The runner's documentation is not the runner: `README.md` describes the
    // gate and changes it no more than any other crate's README changes it.
    if path.starts_with("crates/xtask/") && !path.ends_with(".md") {
        return Some("the gate runner, which also decides this selection");
    }
    if path.rsplit('/').next() == Some("Cargo.toml") {
        return Some(
            "a crate manifest, which can move a feature on a crate that does not depend on it",
        );
    }
    None
}

/// The member whose directory holds `path`; the longest directory wins.
fn owner<'a>(workspace: &'a Workspace, path: &str) -> Option<&'a Member> {
    workspace
        .members
        .iter()
        .filter(|member| covers(&member.dir, path))
        .max_by_key(|member| member.dir.len())
}

/// Is `path` the directory `dir` itself, or something under it?
fn covers(dir: &str, path: &str) -> bool {
    path == dir
        || (path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/')
}

/// The decision, over plain data so every branch is testable without a tree.
pub fn plan(workspace: &Workspace, reads: &Reads, base: &str, changed: &[String]) -> Plan {
    let total = workspace.members.len();
    let mut wide = BTreeSet::new();
    let mut seeds: BTreeMap<String, String> = BTreeMap::new();
    for path in changed {
        if let Some(reason) = workspace_wide(path) {
            wide.insert(format!("{path} is {reason}"));
            continue;
        }
        if let Some(member) = owner(workspace, path) {
            seeds
                .entry(member.name.clone())
                .or_insert_with(|| format!("edited ({path})"));
            continue;
        }
        for (reader, dirs) in &reads.dirs {
            if let Some(dir) = dirs.iter().find(|dir| covers(dir, path)) {
                seeds
                    .entry(reader.clone())
                    .or_insert_with(|| format!("reads {dir} ({path} changed)"));
            }
        }
    }
    if !wide.is_empty() {
        return Plan::whole(total, base, changed.len(), wide.into_iter().collect());
    }

    // Reverse edges: who is affected when `x` changes.
    let mut dependents: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for member in &workspace.members {
        for dep in &member.deps {
            dependents
                .entry(dep.as_str())
                .or_default()
                .insert(member.name.as_str());
        }
    }
    for (reader, source) in &reads.includes {
        dependents
            .entry(source.as_str())
            .or_default()
            .insert(reader.as_str());
    }

    let mut selected: BTreeMap<String, String> = seeds;
    let mut queue: Vec<String> = selected.keys().cloned().collect();
    while let Some(current) = queue.pop() {
        let Some(next) = dependents.get(current.as_str()) else {
            continue;
        };
        for dependent in next {
            if !selected.contains_key(*dependent) {
                selected.insert((*dependent).to_owned(), format!("depends on {current}"));
                queue.push((*dependent).to_owned());
            }
        }
    }
    Plan {
        scope: Scope::Crates(selected.into_iter().collect()),
        total,
        base: base.to_owned(),
        changed: changed.len(),
    }
}

/// The `local` profile's selection, from the tree and git. Any failure to find
/// out what changed is the whole workspace, never a guess.
pub fn for_local(root: &Path) -> Plan {
    let workspace = match load_workspace(root) {
        Ok(workspace) => workspace,
        Err(error) => {
            return Plan::whole(
                0,
                "unknown",
                0,
                vec![format!("the workspace could not be read: {error}")],
            );
        }
    };
    let total = workspace.members.len();
    if std::env::var(TESTS_ENV).is_ok_and(|value| value.trim() == "all") {
        return Plan::whole(total, "-", 0, vec![format!("{TESTS_ENV}=all was set")]);
    }
    let changes = match changed_files(root) {
        Ok(changes) => changes,
        Err(error) => return Plan::whole(total, "none", 0, vec![error]),
    };
    // Reading ten megabytes of source is only worth it when it can narrow.
    let reads = if changes
        .files
        .iter()
        .any(|path| workspace_wide(path).is_some())
    {
        Reads::default()
    } else {
        scan_reads(root, &workspace)
    };
    plan(&workspace, &reads, &changes.base, &changes.files)
}

// ---------------------------------------------------------------------------
// The tree: members, and what changed
// ---------------------------------------------------------------------------

/// The workspace members and the edges between them, from `cargo metadata`.
/// `--no-deps` resolves nothing and needs no network.
pub fn load_workspace(root: &Path) -> Result<Workspace, String> {
    let output = Command::new("cargo")
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--offline",
        ])
        .current_dir(root)
        .output()
        .map_err(|error| format!("`cargo metadata` did not start: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "`cargo metadata` exited {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .next()
                .unwrap_or("(no stderr)")
        ));
    }
    let document: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("`cargo metadata` printed no JSON: {error}"))?;
    workspace_from_metadata(root, &document)
}

/// [`load_workspace`]'s parse, over the document, so it is testable.
pub fn workspace_from_metadata(root: &Path, document: &Value) -> Result<Workspace, String> {
    let packages = document["packages"]
        .as_array()
        .ok_or("`cargo metadata` listed no packages")?;
    let names: BTreeSet<&str> = packages
        .iter()
        .filter_map(|package| package["name"].as_str())
        .collect();
    let canonical_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut members = Vec::new();
    for package in packages {
        let name = package["name"].as_str().ok_or("a package has no name")?;
        let manifest = Path::new(
            package["manifest_path"]
                .as_str()
                .ok_or("a package has no manifest path")?,
        );
        let directory = manifest.parent().ok_or("a manifest has no directory")?;
        let relative = directory
            .strip_prefix(root)
            .or_else(|_| directory.strip_prefix(&canonical_root))
            .map_err(|_| format!("{name} lives outside the repository root"))?;
        let deps = package["dependencies"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter(|dep| dep["path"].is_string())
                    .filter_map(|dep| dep["name"].as_str())
                    .filter(|dep| names.contains(dep) && *dep != name)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        members.push(Member {
            name: name.to_owned(),
            dir: slash(relative),
            deps,
        });
    }
    members.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Workspace { members })
}

/// The files that differ from the base: tracked changes (committed, staged and
/// unstaged) and untracked files that are not ignored.
pub fn changed_files(root: &Path) -> Result<Changes, String> {
    changed_files_against(root, std::env::var(BASE_ENV).ok().as_deref())
}

/// [`changed_files`], with the base named by the caller instead of the
/// environment (a test cannot set a variable the other tests are reading).
pub fn changed_files_against(root: &Path, named: Option<&str>) -> Result<Changes, String> {
    let (base, label) = base_commit(root, named)?;
    let diff = git(root, &["diff", "--name-only", "--no-renames", "-z", &base])?;
    let untracked = git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let untracked: Vec<String> = untracked
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    let identical = identical_to_base(root, &base, &untracked);
    // Diffing against a tree reports a file the index lacks as changed whatever
    // is on disk, so the identical ones are removed from both lists.
    let mut files: BTreeSet<String> = diff
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    files.extend(untracked);
    files.retain(|path| !identical.contains(path));
    Ok(Changes {
        base: label,
        files: files.into_iter().collect(),
    })
}

/// The untracked files whose bytes are exactly the base's copy.
///
/// An untracked file is a change against any base that does not contain it.
/// Against a base that does — a tree built from the working copy, which is how
/// `CENTRAID_GATE_BASE` can name "everything as of a moment ago" — it is not,
/// and counting it would make a run that changed nothing look like it had.
fn identical_to_base(root: &Path, base: &str, untracked: &[String]) -> BTreeSet<String> {
    if untracked.is_empty() {
        return BTreeSet::new();
    }
    let Ok(listing) = git(root, &["ls-tree", "-r", "-z", base]) else {
        return BTreeSet::new();
    };
    let mut in_base: BTreeMap<&str, &str> = BTreeMap::new();
    for entry in listing.split('\0') {
        // `<mode> <type> <oid>\t<path>`
        if let Some((meta, path)) = entry.split_once('\t')
            && let Some(oid) = meta.split(' ').nth(2)
        {
            in_base.insert(path, oid);
        }
    }
    let candidates: Vec<(&String, &str)> = untracked
        .iter()
        .filter(|path| !path.contains('\n'))
        .filter_map(|path| in_base.get(path.as_str()).map(|oid| (path, *oid)))
        .collect();
    if candidates.is_empty() {
        return BTreeSet::new();
    }
    let Ok(mut child) = Command::new("git")
        .args(["hash-object", "--stdin-paths"])
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return BTreeSet::new();
    };
    let mut stdin = child.stdin.take();
    let input: String = candidates
        .iter()
        .map(|(path, _)| format!("{path}\n"))
        .collect();
    // Written on its own thread: a child that fills its output pipe while this
    // one is still writing would otherwise wait on each other forever.
    let writer = std::thread::spawn(move || {
        use std::io::Write as _;
        if let Some(stdin) = stdin.as_mut() {
            let _ = stdin.write_all(input.as_bytes());
        }
    });
    let output = child.wait_with_output();
    let _ = writer.join();
    let Ok(output) = output else {
        return BTreeSet::new();
    };
    let hashes = String::from_utf8_lossy(&output.stdout);
    candidates
        .iter()
        .zip(hashes.lines())
        .filter(|((_, oid), hash)| oid == hash)
        .map(|((path, _), _)| (*path).clone())
        .collect()
}

/// The commit (or tree) to diff against, and the short name the evidence uses.
fn base_commit(root: &Path, named: Option<&str>) -> Result<(String, String), String> {
    if let Some(named) = named.map(str::trim)
        && !named.is_empty()
    {
        let sha = git(root, &["rev-parse", "--verify", "--quiet", named])
            .map(|text| text.trim().to_owned())
            .ok()
            .filter(|text| !text.is_empty())
            .ok_or_else(|| format!("{BASE_ENV}={named} names no commit or tree"))?;
        // A commit is compared at its merge base with HEAD, like the default;
        // a tree has no history, so it is the base exactly as named.
        let kind = git(root, &["cat-file", "-t", &sha])
            .map(|text| text.trim().to_owned())
            .unwrap_or_default();
        if kind == "commit"
            && let Ok(merge) = git(root, &["merge-base", "HEAD", &sha])
            && !merge.trim().is_empty()
        {
            let merge = merge.trim().to_owned();
            return Ok((
                merge.clone(),
                format!("{BASE_ENV}={named} ({})", short(&merge)),
            ));
        }
        return Ok((sha.clone(), format!("{BASE_ENV}={named} ({})", short(&sha))));
    }
    match ledger::merge_base(root) {
        Some(sha) => Ok((sha.clone(), short(&sha))),
        None => Err(
            "no merge base with the default branch was found (tried origin/main, main, \
             origin/master, master), so there is nothing to compare the change against. \
             Fetch the default branch, or set CENTRAID_GATE_BASE"
                .to_owned(),
        ),
    }
}

fn short(sha: &str) -> String {
    sha.chars().take(8).collect()
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("`git {}` did not start: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "`git {}` exited {}",
            args.join(" "),
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

// ---------------------------------------------------------------------------
// What the sources read
// ---------------------------------------------------------------------------

/// The crate whose reads are not scanned, and why: `crates/xtask` names a great
/// many repository paths in its own messages and reads the live tree through
/// its *steps*, which are steps of this very profile. Its unit tests build
/// fixture trees. Scanning it would make every documentation edit select it,
/// for tests that cannot see the documentation.
const UNSCANNED: &str = "xtask";

/// Scan every member's Rust for the files it names outside its own directory.
///
/// Over-approximating by design: a path that merely appears in a message
/// literal selects its reader, which costs a few seconds of tests. A missed
/// read would skip tests that should have run, so each ambiguity resolves to
/// "read". Comments are skipped — this repository cites `docs/decisions.md`
/// from nearly every module, and counting those would make every documentation
/// edit select every crate.
pub fn scan_reads(root: &Path, workspace: &Workspace) -> Reads {
    let mut reads = Reads::default();
    for member in &workspace.members {
        if member.name == UNSCANNED {
            continue;
        }
        let member_dir = root.join(&member.dir);
        let mut files = Vec::new();
        rust_files(&member_dir, &mut files);
        for file in files {
            let Ok(bytes) = fs::read(&file) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            let file_dir = file.parent().unwrap_or(&member_dir).to_path_buf();
            let context = FileContext {
                root,
                workspace,
                member,
                member_dir: &member_dir,
                file_dir: &file_dir,
            };
            for hit in literal_reads(&text, &context) {
                record(&mut reads, &context, &hit);
            }
        }
    }
    reads
}

/// The derived read table, one line per crate, for `cargo xtask test-plan
/// --reads`.
pub fn describe_reads(reads: &Reads) -> String {
    let mut out = String::from("reads outside each crate's own directory:\n");
    let readers: BTreeSet<&String> = reads
        .dirs
        .keys()
        .chain(reads.includes.iter().map(|(reader, _)| reader))
        .collect();
    for reader in readers {
        let mut parts: Vec<String> = reads
            .dirs
            .get(reader)
            .map(|dirs| dirs.iter().cloned().collect())
            .unwrap_or_default();
        parts.extend(
            reads
                .includes
                .iter()
                .filter(|(who, _)| who == reader)
                .map(|(_, source)| format!("(sources of {source})")),
        );
        out.push_str(&format!("  {reader:<26} {}\n", parts.join(", ")));
    }
    out
}

struct FileContext<'a> {
    root: &'a Path,
    workspace: &'a Workspace,
    member: &'a Member,
    member_dir: &'a Path,
    file_dir: &'a Path,
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if name != "target" && name != "node_modules" && !name.starts_with('.') {
                rust_files(&path, out);
            }
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// A repository-relative path a literal named, and the directory it stands for.
struct Hit {
    /// What exists on disk, repository-relative.
    path: String,
    is_dir: bool,
}

fn record(reads: &mut Reads, context: &FileContext<'_>, hit: &Hit) {
    if hit.path.is_empty() {
        return;
    }
    // Inside the crate's own directory: not a read of anything else.
    if covers(&context.member.dir, &hit.path) {
        return;
    }
    // Climbing to a directory above the crate (`crates`, the root) is
    // navigation, not a read.
    if covers(&hit.path, &context.member.dir) {
        return;
    }
    if let Some(source) = owner(context.workspace, &hit.path) {
        reads
            .includes
            .insert((context.member.name.clone(), source.name.clone()));
        return;
    }
    let dir = if hit.is_dir {
        hit.path.clone()
    } else {
        match hit.path.rsplit_once('/') {
            Some((parent, _)) => parent.to_owned(),
            // A file at the repository root stands for itself, not for the root.
            None => hit.path.clone(),
        }
    };
    reads
        .dirs
        .entry(context.member.name.clone())
        .or_default()
        .insert(dir);
}

/// Every existing repository path the string literals of `source` name.
fn literal_reads(source: &str, context: &FileContext<'_>) -> Vec<Hit> {
    let literals = literals(source);
    // A file that climbs (`".."`, `"../x"`) is computing a path to somewhere
    // above itself; only then is a bare `"design"` a directory name and not a
    // word.
    let climbs = literals.iter().any(|literal| {
        literal.text == ".." || literal.text.starts_with("../") || literal.text.starts_with("/../")
    });
    let mut hits = Vec::new();
    // The deepest directory the current run of segments has named, as in
    // `"..", "..", "contracts", "time"` or `.join("contracts").join("time")`.
    let mut pending: Option<Hit> = None;
    let mut after_dots = false;
    for literal in &literals {
        let adjacent = literal.gap.chars().all(|c| c == ',' || c.is_whitespace());
        let gap = literal.gap.trim_end();
        let include = gap.ends_with("include_str!(")
            || gap.ends_with("include_bytes!(")
            || gap.ends_with("include!(");
        let join_context = gap.ends_with(".join(")
            || gap.ends_with("::new(")
            || gap.ends_with("::from(")
            || gap.ends_with(".push(");
        let single = !literal.text.contains('/')
            && !literal.text.is_empty()
            && literal.text.chars().all(is_path_char);
        let dots = single && (literal.text == ".." || literal.text == ".");

        // A bare segment either extends the directory the last one named, or
        // starts a new run at the root.
        let mut consumed = false;
        if single && !dots {
            if let Some(current) = &pending
                && current.is_dir
                && (adjacent || join_context)
                && let Some(next) = existing(
                    context.root,
                    &format!("{}/{}", current.path, literal.text),
                    false,
                )
            {
                pending = Some(next);
                consumed = true;
            } else {
                hits.extend(pending.take());
                if climbs
                    && (join_context || (adjacent && after_dots))
                    && literal.text != "crates"
                    && let Some(start) = existing(context.root, &literal.text, false)
                {
                    pending = Some(start);
                    consumed = true;
                }
            }
        } else {
            hits.extend(pending.take());
        }
        after_dots = dots;
        if consumed {
            continue;
        }

        for token in tokens(&literal.text) {
            let relative = token.trim_start_matches('/');
            if relative.is_empty() || !relative.contains('/') {
                continue;
            }
            let trailing = relative.ends_with('/');
            let mut bases: Vec<PathBuf> = Vec::new();
            if relative.starts_with("..") {
                bases.push(context.file_dir.to_path_buf());
                if !include {
                    bases.push(context.member_dir.to_path_buf());
                }
            } else if context.member_dir.join(relative).exists()
                || context.file_dir.join(relative).exists()
            {
                // The crate's own file, spelled relative to the crate.
                continue;
            } else {
                bases.push(context.root.to_path_buf());
            }
            for base in bases {
                let Some(resolved) = lexical_join(&base, relative) else {
                    continue;
                };
                let Ok(inside) = resolved.strip_prefix(context.root) else {
                    continue;
                };
                if let Some(hit) = existing(context.root, &slash(inside), trailing) {
                    hits.push(hit);
                }
            }
        }
    }
    hits.extend(pending);
    hits
}

/// `relative` under `root`, if it exists (or ends in `/` and its directory does).
fn existing(root: &Path, relative: &str, trailing_slash: bool) -> Option<Hit> {
    let trimmed = relative.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let metadata = fs::metadata(root.join(trimmed)).ok()?;
    if metadata.is_dir() {
        return Some(Hit {
            path: trimmed.to_owned(),
            is_dir: true,
        });
    }
    if trailing_slash {
        return None;
    }
    Some(Hit {
        path: trimmed.to_owned(),
        is_dir: false,
    })
}

/// `base` joined with `relative`, with `.` and `..` folded away.
fn lexical_join(base: &Path, relative: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if !out.pop() {
                    return None;
                }
            }
            normal => out.push(normal),
        }
    }
    Some(out)
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/')
}

/// Maximal runs of path characters.
fn tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !is_path_char(c))
        .filter(|token| !token.is_empty())
}

// ---------------------------------------------------------------------------
// A string-literal lexer, because comments must not count
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub struct Literal {
    pub text: String,
    /// The code (never a comment) between the previous literal and this one,
    /// truncated to its tail. What the call looks like around the literal.
    pub gap: String,
}

/// Every string literal of a Rust source, in order, with comments skipped.
///
/// Not a parser: it knows exactly enough to tell a literal from a comment, a
/// character literal from a lifetime, and a raw string from an identifier.
pub fn literals(source: &str) -> Vec<Literal> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut gap = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        match byte {
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let mut depth = 1;
                i += 2;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            b'"' => {
                let (text, next) = read_string(bytes, i + 1);
                out.push(Literal {
                    text,
                    gap: take_gap(&mut gap),
                });
                i = next;
            }
            b'r' if starts_raw_string(bytes, i) => {
                let mut j = i + 1;
                let mut hashes = 0;
                while bytes.get(j) == Some(&b'#') {
                    hashes += 1;
                    j += 1;
                }
                // `starts_raw_string` saw the opening quote.
                j += 1;
                let start = j;
                let closing = {
                    let mut needle = vec![b'"'];
                    needle.extend(std::iter::repeat_n(b'#', hashes));
                    needle
                };
                let mut end = bytes.len();
                let mut k = start;
                while k + closing.len() <= bytes.len() {
                    if bytes[k..k + closing.len()] == closing[..] {
                        end = k;
                        break;
                    }
                    k += 1;
                }
                out.push(Literal {
                    text: String::from_utf8_lossy(&bytes[start..end]).into_owned(),
                    gap: take_gap(&mut gap),
                });
                i = (end + closing.len()).min(bytes.len());
            }
            b'\'' => {
                if bytes.get(i + 1) == Some(&b'\\') {
                    // An escaped character literal: skip to its closing quote.
                    let mut j = i + 2;
                    if j < bytes.len() {
                        j += 1;
                    }
                    while j < bytes.len() && bytes[j] != b'\'' {
                        j += 1;
                    }
                    i = j + 1;
                } else if let Some(character) = source[i + 1..].chars().next() {
                    let after = i + 1 + character.len_utf8();
                    if bytes.get(after) == Some(&b'\'') {
                        i = after + 1;
                    } else {
                        // A lifetime.
                        gap.push('\'');
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            other => {
                gap.push(if other.is_ascii() { other as char } else { '?' });
                if gap.len() > 256 {
                    let keep = gap.len() - 96;
                    gap.drain(..keep);
                }
                i += 1;
            }
        }
    }
    out
}

fn take_gap(gap: &mut String) -> String {
    let tail = if gap.len() > 96 {
        gap[gap.len() - 96..].to_owned()
    } else {
        gap.clone()
    };
    gap.clear();
    tail
}

/// Is the `r` at `index` the start of a raw string, and not the end of an
/// identifier (`for"`, `attr#`)? A `b` before it (`br"…"`) is allowed.
fn starts_raw_string(bytes: &[u8], index: usize) -> bool {
    let before = index
        .checked_sub(1)
        .map(|at| bytes[at])
        .filter(|byte| byte.is_ascii_alphanumeric() || *byte == b'_');
    match before {
        None => {}
        Some(b'b') => {
            let earlier = index
                .checked_sub(2)
                .map(|at| bytes[at])
                .filter(|byte| byte.is_ascii_alphanumeric() || *byte == b'_');
            if earlier.is_some() {
                return false;
            }
        }
        Some(_) => return false,
    }
    let mut j = index + 1;
    while bytes.get(j) == Some(&b'#') {
        j += 1;
    }
    bytes.get(j) == Some(&b'"')
}

/// The body of a normal string whose opening quote is just behind `start`, and
/// the index after its closing quote.
fn read_string(bytes: &[u8], start: usize) -> (String, usize) {
    let mut text = Vec::new();
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return (String::from_utf8_lossy(&text).into_owned(), i + 1),
            b'\\' => {
                i += 1;
                match bytes.get(i) {
                    Some(b'\n') => {
                        while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
                            i += 1;
                        }
                    }
                    Some(b'n' | b't' | b'r') => {
                        text.push(b' ');
                        i += 1;
                    }
                    Some(other) => {
                        text.push(*other);
                        i += 1;
                    }
                    None => {}
                }
            }
            other => {
                text.push(other);
                i += 1;
            }
        }
    }
    (String::from_utf8_lossy(&text).into_owned(), bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::fixture_dir;

    fn member(name: &str, dir: &str, deps: &[&str]) -> Member {
        Member {
            name: name.to_owned(),
            dir: dir.to_owned(),
            deps: deps.iter().map(|dep| (*dep).to_owned()).collect(),
        }
    }

    /// A small workspace shaped like this one: a vault, an app over it, and a
    /// core over both, with a leaf beside them that depends on nothing.
    fn workspace() -> Workspace {
        Workspace {
            members: vec![
                member("vault", "crates/vault", &[]),
                member("app", "crates/apps/app", &["vault"]),
                member("core", "crates/core", &["app", "vault"]),
                member("leaf", "crates/leaf", &[]),
                member("xtask", "crates/xtask", &[]),
            ],
        }
    }

    fn changed(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| (*path).to_owned()).collect()
    }

    fn names(plan: &Plan) -> Vec<String> {
        match &plan.scope {
            Scope::Crates(selected) => selected.iter().map(|(name, _)| name.clone()).collect(),
            Scope::Whole(_) => panic!("expected a narrowed plan, got {plan:?}"),
        }
    }

    fn why<'a>(plan: &'a Plan, name: &str) -> &'a str {
        match &plan.scope {
            Scope::Crates(selected) => selected
                .iter()
                .find(|(selected_name, _)| selected_name == name)
                .map(|(_, why)| why.as_str())
                .unwrap_or_else(|| panic!("{name} is not selected: {plan:?}")),
            Scope::Whole(_) => panic!("expected a narrowed plan"),
        }
    }

    #[test]
    fn an_edit_selects_its_crate_and_everything_that_depends_on_it() {
        let selected = plan(
            &workspace(),
            &Reads::default(),
            "abc",
            &changed(&["crates/vault/src/lib.rs"]),
        );
        assert_eq!(names(&selected), ["app", "core", "vault"]);
        assert!(why(&selected, "vault").starts_with("edited"));
        assert_eq!(why(&selected, "app"), "depends on vault");
        assert!(selected.narrowed());
        assert_eq!(
            selected.filterset().as_deref(),
            Some("package(=app) | package(=core) | package(=vault)")
        );
    }

    #[test]
    fn a_leaf_edit_selects_only_the_leaf() {
        let selected = plan(
            &workspace(),
            &Reads::default(),
            "abc",
            &changed(&["crates/leaf/src/lib.rs", "crates/leaf/tests/a.rs"]),
        );
        assert_eq!(names(&selected), ["leaf"]);
        assert!(selected.describe().contains("NARROWED to 1 of 5"));
    }

    #[test]
    fn a_nested_member_is_not_mistaken_for_its_parent_directory() {
        let selected = plan(
            &workspace(),
            &Reads::default(),
            "abc",
            &changed(&["crates/apps/app/src/lib.rs", "crates/apps/README.md"]),
        );
        assert_eq!(names(&selected), ["app", "core"]);
    }

    #[test]
    fn a_directory_whose_name_merely_starts_like_a_member_is_not_that_member() {
        let selected = plan(
            &workspace(),
            &Reads::default(),
            "abc",
            &changed(&["crates/vault-notes/src/lib.rs"]),
        );
        assert!(names(&selected).is_empty());
    }

    #[test]
    fn documentation_and_other_trees_no_crate_reads_select_nothing() {
        let selected = plan(
            &workspace(),
            &Reads::default(),
            "abc",
            &changed(&[
                "docs/decisions.md",
                "README.md",
                "scripts/lint-copy.mjs",
                "mobile/shared/src/Foo.kt",
                ".github/workflows/gate.yml",
                "receipts/issue-1.md",
            ]),
        );
        assert!(names(&selected).is_empty());
        assert!(selected.narrowed());
        assert_eq!(selected.filterset(), None);
        assert!(selected.describe().contains("NARROWED to 0 of 5"));
        assert!(selected.describe().contains("No Rust test ran"));
    }

    #[test]
    fn every_workspace_wide_input_runs_the_whole_workspace() {
        for path in [
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "rust-toolchain",
            ".cargo/config.toml",
            ".config/nextest.toml",
            "crates/xtask/src/gate.rs",
            "crates/xtask/Cargo.toml",
            "crates/leaf/Cargo.toml",
            "crates/apps/app/Cargo.toml",
        ] {
            let selected = plan(
                &workspace(),
                &Reads::default(),
                "abc",
                &changed(&["crates/leaf/src/lib.rs", path]),
            );
            match &selected.scope {
                Scope::Whole(reasons) => {
                    assert!(
                        reasons.iter().any(|reason| reason.starts_with(path)),
                        "{path}: {reasons:?}"
                    );
                }
                Scope::Crates(_) => panic!("{path} must run the whole workspace"),
            }
            assert!(!selected.narrowed(), "{path}");
            assert_eq!(selected.filterset(), None, "{path}");
            assert!(selected.describe().contains("WHOLE WORKSPACE"), "{path}");
        }
    }

    #[test]
    fn the_runners_own_documentation_is_not_the_runner() {
        let selected = plan(
            &workspace(),
            &Reads::default(),
            "abc",
            &changed(&["crates/xtask/README.md"]),
        );
        assert_eq!(names(&selected), ["xtask"]);
    }

    #[test]
    fn a_tree_a_crate_reads_selects_that_crate_and_its_dependents() {
        let mut reads = Reads::default();
        reads
            .dirs
            .entry("vault".to_owned())
            .or_default()
            .insert("contracts/time".to_owned());
        reads
            .dirs
            .entry("leaf".to_owned())
            .or_default()
            .insert("copy".to_owned());
        let time = plan(
            &workspace(),
            &reads,
            "abc",
            &changed(&["contracts/time/rrule-cases.json"]),
        );
        assert_eq!(names(&time), ["app", "core", "vault"]);
        assert_eq!(
            why(&time, "vault"),
            "reads contracts/time (contracts/time/rrule-cases.json changed)"
        );

        // A sibling directory is not that directory.
        let other = plan(
            &workspace(),
            &reads,
            "abc",
            &changed(&["contracts/timeline/x.json", "contracts/schema/x.sql"]),
        );
        assert!(names(&other).is_empty());

        let copy = plan(&workspace(), &reads, "abc", &changed(&["copy/chat.json"]));
        assert_eq!(names(&copy), ["leaf"]);
    }

    #[test]
    fn a_source_that_includes_another_crates_file_depends_on_that_crate() {
        let mut reads = Reads::default();
        reads
            .includes
            .insert(("leaf".to_owned(), "vault".to_owned()));
        let selected = plan(
            &workspace(),
            &reads,
            "abc",
            &changed(&["crates/vault/src/x.rs"]),
        );
        assert_eq!(names(&selected), ["app", "core", "leaf", "vault"]);
    }

    #[test]
    fn selecting_every_member_is_not_called_narrowed() {
        let all = Plan {
            scope: Scope::Crates(
                workspace()
                    .members
                    .iter()
                    .map(|member| (member.name.clone(), "edited".to_owned()))
                    .collect(),
            ),
            total: 5,
            base: "abc".to_owned(),
            changed: 1,
        };
        assert!(!all.narrowed());
        assert_eq!(all.filterset(), None);
    }

    #[test]
    fn metadata_becomes_members_and_workspace_edges_only() {
        let document = serde_json::json!({
            "packages": [
                {
                    "name": "vault",
                    "manifest_path": "/w/crates/vault/Cargo.toml",
                    "dependencies": [
                        {"name": "serde", "path": null},
                        {"name": "vault", "path": "/w/crates/vault"}
                    ]
                },
                {
                    "name": "app",
                    "manifest_path": "/w/crates/apps/app/Cargo.toml",
                    "dependencies": [
                        {"name": "vault", "path": "/w/crates/vault"},
                        {"name": "serde", "path": null},
                        {"name": "tempfile", "path": null}
                    ]
                }
            ]
        });
        let workspace = workspace_from_metadata(Path::new("/w"), &document).expect("it parses");
        assert_eq!(
            workspace.members,
            vec![
                member("app", "crates/apps/app", &["vault"]),
                member("vault", "crates/vault", &[]),
            ]
        );
    }

    // -- the lexer --------------------------------------------------------

    fn texts(source: &str) -> Vec<String> {
        literals(source)
            .into_iter()
            .map(|literal| literal.text)
            .collect()
    }

    #[test]
    fn comments_are_not_literals() {
        let source = r#"
            // "line comment"
            /* "block" /* "nested" */ still comment "x" */
            //! docs/decisions.md in a doc comment
            let real = "kept";
        "#;
        assert_eq!(texts(source), ["kept"]);
    }

    #[test]
    fn a_comment_marker_inside_a_string_does_not_start_a_comment() {
        assert_eq!(
            texts(r#"let a = "https://example.org/x"; let b = "after";"#),
            ["https://example.org/x", "after"]
        );
    }

    #[test]
    fn raw_strings_character_literals_and_lifetimes_do_not_derail_it() {
        let source = r##"
            fn f<'a>(x: &'a str) -> char { '"' }
            let raw = r#"a "quoted" path/x"#;
            let escaped = '\'';
            let ident = for_each("tail");
            let bytes = b"bytes";
            let after = "last";
        "##;
        assert_eq!(
            texts(source),
            [r#"a "quoted" path/x"#, "tail", "bytes", "last"]
        );
    }

    #[test]
    fn the_gap_names_the_call_around_a_literal() {
        let found = literals(r#"let t = include_str!("../x.json"); root.join("copy");"#);
        assert!(found[0].gap.trim_end().ends_with("include_str!("));
        assert!(found[1].gap.trim_end().ends_with(".join("));
    }

    #[test]
    fn escapes_do_not_end_a_string_early() {
        assert_eq!(
            texts(r#"let a = "say \"hi\" at a/b";"#),
            [r#"say "hi" at a/b"#]
        );
    }

    // -- reads, over a fixture tree --------------------------------------

    /// A repository on disk: two crates, the trees they read from, and a docs
    /// tree nothing reads.
    fn fixture(name: &str) -> (PathBuf, Workspace) {
        let root = fixture_dir(name);
        let write = |path: &str, text: &str| {
            let full = root.join(path);
            fs::create_dir_all(full.parent().expect("a parent")).expect("a directory");
            fs::write(full, text).expect("a file");
        };
        write("contracts/time/cases.json", "{}");
        write("contracts/schema/ddl.sql", "x");
        write("contracts/apps/money/rows.json", "{}");
        write("copy/chat.json", "{}");
        write("docs/decisions.md", "# d");
        write("README.md", "# r");
        write("crates/assist/src/native.rs", "pub fn a() {}");
        write("crates/assist/tests/fixtures/local.json", "{}");
        write(
            "crates/vault/tests/time.rs",
            r#"
            // see docs/decisions.md and "contracts/schema/ddl.sql" in a comment
            fn fixture(name: &str) -> PathBuf {
                [env!("CARGO_MANIFEST_DIR"), "..", "..", "contracts", "time", name]
                    .iter().collect()
            }
            "#,
        );
        write(
            "crates/vault/tests/ddl.rs",
            r#"const DDL: &str = include_str!("../../../contracts/schema/ddl.sql");"#,
        );
        write(
            "crates/vault/tests/local.rs",
            r#"
            let a = include_str!("../tests/fixtures/none.json");
            let b = std::fs::read("tests/out.json");
            let c = "docs/not-a-real-file.md";
            "#,
        );
        write(
            "crates/leaf/src/words.rs",
            r#"
            const COPY: &str = include_str!("../../../copy/chat.json");
            const SRC: &str = include_str!("../../assist/src/native.rs");
            "#,
        );
        write(
            "crates/leaf/tests/money.rs",
            r#"
            fn root() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..") }
            fn rows() { std::fs::read(root().join("contracts/apps/money/rows.json")); }
            fn apps() -> [&'static str; 3] { ["agenda", "docs", "money"] }
            "#,
        );
        let workspace = Workspace {
            members: vec![
                member("assist", "crates/assist", &[]),
                member("leaf", "crates/leaf", &[]),
                member("vault", "crates/vault", &[]),
            ],
        };
        (root, workspace)
    }

    #[test]
    fn the_scan_derives_who_reads_what_from_the_sources_alone() {
        let (root, workspace) = fixture("select-scan");
        let reads = scan_reads(&root, &workspace);
        let dirs = |name: &str| -> Vec<String> {
            reads
                .dirs
                .get(name)
                .map(|set| set.iter().cloned().collect())
                .unwrap_or_default()
        };
        // A segment-list read, an include, and a comment that must not count.
        assert_eq!(dirs("vault"), ["contracts/schema", "contracts/time"]);
        // A relative include and a root-relative read through a helper; the
        // word "docs" in a list of app names is not the docs directory.
        assert_eq!(dirs("leaf"), ["contracts/apps/money", "copy"]);
        assert!(dirs("assist").is_empty(), "{:?}", reads.dirs);
        // The leaf's source reaches into the assistant's directory.
        assert_eq!(
            reads.includes.iter().cloned().collect::<Vec<_>>(),
            [("leaf".to_owned(), "assist".to_owned())]
        );
    }

    #[test]
    fn a_crates_own_files_and_paths_that_do_not_exist_are_not_reads() {
        let (root, workspace) = fixture("select-local");
        let reads = scan_reads(&root, &workspace);
        let vault = reads.dirs.get("vault").expect("vault reads something");
        assert!(
            !vault
                .iter()
                .any(|dir| dir.starts_with("docs") || dir == "tests"),
            "{vault:?}"
        );
    }

    #[test]
    fn the_scanned_reads_drive_the_plan_end_to_end() {
        let (root, workspace) = fixture("select-plan");
        let reads = scan_reads(&root, &workspace);
        let time = plan(
            &workspace,
            &reads,
            "abc",
            &changed(&["contracts/time/cases.json"]),
        );
        assert_eq!(names(&time), ["vault"]);
        let chat = plan(&workspace, &reads, "abc", &changed(&["copy/chat.json"]));
        assert_eq!(names(&chat), ["leaf"]);
        let source = plan(
            &workspace,
            &reads,
            "abc",
            &changed(&["crates/assist/src/native.rs"]),
        );
        assert_eq!(
            names(&source),
            ["assist", "leaf"],
            "an include makes the includer depend on the includee"
        );
        let docs = plan(
            &workspace,
            &reads,
            "abc",
            &changed(&["docs/decisions.md", "README.md"]),
        );
        assert!(
            names(&docs).is_empty(),
            "a doc edit selects nothing: {docs:?}"
        );
    }

    // -- changed files, over real git repositories -------------------------

    fn git_in(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(root)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn put(root: &Path, path: &str, text: &str) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().expect("a parent")).expect("a directory");
        fs::write(full, text).expect("a file");
    }

    /// `main` holds three files and an ignore rule; the repository is left on a
    /// branch cut from it.
    fn repo(name: &str) -> PathBuf {
        let root = fixture_dir(name);
        git_in(&root, &["init", "--quiet", "-b", "main"]);
        put(&root, ".gitignore", "*.log\n");
        for file in ["keep.rs", "edit.rs", "gone.rs"] {
            put(&root, file, "1\n");
        }
        git_in(&root, &["add", "-A"]);
        git_in(&root, &["commit", "--quiet", "-m", "base"]);
        git_in(&root, &["checkout", "--quiet", "-b", "feature"]);
        root
    }

    fn files(changes: &Changes) -> Vec<&str> {
        changes.files.iter().map(String::as_str).collect()
    }

    #[test]
    fn changed_means_committed_staged_unstaged_untracked_and_deleted_but_not_ignored() {
        let root = repo("select-git-all");
        put(&root, "committed.rs", "1\n");
        git_in(&root, &["add", "committed.rs"]);
        git_in(&root, &["commit", "--quiet", "-m", "committed"]);
        put(&root, "staged.rs", "1\n");
        git_in(&root, &["add", "staged.rs"]);
        put(&root, "edit.rs", "2\n");
        put(&root, "untracked.rs", "1\n");
        put(&root, "noise.log", "1\n");
        fs::remove_file(root.join("gone.rs")).expect("a deletion");
        let changes = changed_files_against(&root, None).expect("a base exists");
        assert_eq!(
            files(&changes),
            [
                "committed.rs",
                "edit.rs",
                "gone.rs",
                "staged.rs",
                "untracked.rs"
            ]
        );
    }

    #[test]
    fn the_base_is_the_merge_base_so_the_default_branch_moving_on_is_not_my_change() {
        let root = repo("select-git-merge-base");
        put(&root, "mine.rs", "1\n");
        git_in(&root, &["add", "mine.rs"]);
        git_in(&root, &["commit", "--quiet", "-m", "mine"]);
        git_in(&root, &["checkout", "--quiet", "main"]);
        put(&root, "theirs.rs", "1\n");
        git_in(&root, &["add", "theirs.rs"]);
        git_in(&root, &["commit", "--quiet", "-m", "theirs"]);
        git_in(&root, &["checkout", "--quiet", "feature"]);
        let changes = changed_files_against(&root, None).expect("a base exists");
        assert_eq!(files(&changes), ["mine.rs"]);
    }

    #[test]
    fn no_default_branch_means_no_base_and_the_reason_says_so() {
        let root = fixture_dir("select-git-no-base");
        git_in(&root, &["init", "--quiet", "-b", "trunk"]);
        put(&root, "a.rs", "1\n");
        git_in(&root, &["add", "-A"]);
        git_in(&root, &["commit", "--quiet", "-m", "base"]);
        let error =
            changed_files_against(&root, None).expect_err("there is nothing to diff against");
        assert!(error.contains("no merge base"), "{error}");
        assert!(error.contains(BASE_ENV), "{error}");
    }

    #[test]
    fn a_named_commit_is_compared_at_its_merge_base() {
        let root = repo("select-git-named-commit");
        put(&root, "mine.rs", "1\n");
        git_in(&root, &["add", "mine.rs"]);
        git_in(&root, &["commit", "--quiet", "-m", "mine"]);
        git_in(&root, &["checkout", "--quiet", "main"]);
        put(&root, "theirs.rs", "1\n");
        git_in(&root, &["add", "theirs.rs"]);
        git_in(&root, &["commit", "--quiet", "-m", "theirs"]);
        git_in(&root, &["checkout", "--quiet", "feature"]);
        let changes = changed_files_against(&root, Some("main")).expect("main names a commit");
        assert_eq!(files(&changes), ["mine.rs"]);
        assert!(changes.base.starts_with(BASE_ENV), "{}", changes.base);
        let error =
            changed_files_against(&root, Some("no-such-ref")).expect_err("it names nothing");
        assert!(error.contains("names no commit or tree"), "{error}");
    }

    #[test]
    fn a_tree_of_the_working_copy_is_a_base_that_counts_nothing_already_in_it() {
        let root = repo("select-git-tree");
        put(&root, "edit.rs", "2\n");
        put(&root, "fresh.rs", "1\n");
        git_in(&root, &["add", "-A"]);
        let tree = git_in(&root, &["write-tree"]);
        git_in(&root, &["reset", "--quiet"]);
        // Nothing has changed since the tree was written, though `fresh.rs` is
        // untracked and `edit.rs` differs from the commit.
        let none = changed_files_against(&root, Some(&tree)).expect("a tree names a base");
        assert!(files(&none).is_empty(), "{:?}", none.files);
        put(&root, "edit.rs", "3\n");
        put(&root, "later.rs", "1\n");
        let some = changed_files_against(&root, Some(&tree)).expect("a tree names a base");
        assert_eq!(files(&some), ["edit.rs", "later.rs"]);
    }

    // -- the real tree -----------------------------------------------------

    /// The tree this test runs in: a change to `centraid-vault` selects what
    /// depends on it, and a documentation edit selects nothing. Both are facts
    /// about the repository's shape that the rule above promises and a rename
    /// would break.
    #[test]
    fn on_the_real_tree_a_vault_edit_reaches_core_and_a_doc_edit_reaches_nothing() {
        let root = crate::repo_root();
        let workspace = load_workspace(&root).expect("cargo metadata reads this workspace");
        assert!(
            workspace
                .members
                .iter()
                .any(|member| member.name == "centraid-vault"),
            "{:?}",
            workspace.members
        );
        let reads = scan_reads(&root, &workspace);
        let vault = plan(
            &workspace,
            &reads,
            "abc",
            &changed(&["crates/vault/src/lib.rs"]),
        );
        let selected = names(&vault);
        assert!(selected.contains(&"centraid-vault".to_owned()));
        assert!(
            selected.contains(&"centraid-core".to_owned()),
            "core depends on vault: {selected:?}"
        );
        assert!(
            selected.len() < workspace.members.len(),
            "a vault edit must not select every crate: {selected:?}"
        );
        let docs = plan(
            &workspace,
            &reads,
            "abc",
            &changed(&["docs/decisions.md", "QUALITY.md"]),
        );
        assert!(names(&docs).is_empty(), "{docs:?}");
        // The migrations are `include_str!`d by the vault, so editing one runs
        // the vault and what depends on it.
        let migration = plan(
            &workspace,
            &reads,
            "abc",
            &changed(&["contracts/migrations/001_baseline.sql"]),
        );
        assert!(
            names(&migration).contains(&"centraid-vault".to_owned()),
            "{migration:?}"
        );
    }
}
