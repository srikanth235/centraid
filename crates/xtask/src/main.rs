#![forbid(unsafe_code)]
//! `cargo xtask` — the v1 tree's only cross-cutting entrypoint (#1020).
//!
//! Rule two of this repository is "never compromise on tooling", and v1 is
//! three languages. Anything that has to hold across all of them cannot live in
//! any one of them, so it lives here: `cargo xtask gate --profile <local|pr|
//! nightly|release>` is the single command CI runs and the single command the
//! local loop runs. A fifth profile, `mobile-jvm`, runs the Kotlin/Gradle JVM
//! suites; it is not a superset of any other and is not charged to `pr`, for
//! the reason in its ledger row (#1020, D-1020-B2-3). See `crates/xtask/README.md` for the profiles, the budgets,
//! where failure artifacts land, and the one thing this runner deliberately
//! does NOT do (governance — it has its own workflow).

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};

mod artifact;
mod ci;
mod gate;
mod ledger;
mod measure;
mod rules;
mod smoke;
#[cfg(test)]
mod testing;

#[derive(Parser)]
#[command(
    name = "xtask",
    about = "Centraid v1 cross-cutting tasks (#1020)",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run a gate profile: every step, buffered, with a timing table and a budget.
    Gate {
        /// Which profile to run.
        #[arg(long, value_enum)]
        profile: Profile,
        /// Score this run as a first build even if artifacts are on disk.
        ///
        /// `local` detects warm and cold trees on its own; this is for proving
        /// the cold branch without deleting `target/` (#1020, D-1020-B2-1).
        #[arg(long)]
        cold: bool,
        /// Run only one step of the profile, by name — or one of the four
        /// device lanes, which narrows the run to `device-lanes`. A name that
        /// matches nothing is an error, never an empty run that reports PASS
        /// over zero steps (#1020, D-1020-G4).
        #[arg(long)]
        lane: Option<String>,
    },
    /// Run only the structural rules (the cheap half of every profile).
    Rules,
    /// Print the repository root every path-based rule will scan.
    ///
    /// One line, and it exists because the root was once baked in at compile
    /// time: with a shared `CARGO_TARGET_DIR` the cached binary scanned
    /// whichever worktree built it last and reported clean over a tree nobody
    /// asked about (#1020 wave 3). A root you cannot print is a root you cannot
    /// check, so `crates/xtask/tests/repo_root.rs` runs this from a second
    /// checkout and asserts the answer is the cwd's.
    RepoRoot,
    /// Print the prebuilt core's cache key for a target triple (#1020,
    /// D-1020-G2). The exact rule is in `src/artifact.rs`.
    ArtifactKey {
        /// The target triple the artifact is for.
        #[arg(long)]
        triple: String,
        /// Cargo features, comma-separated. Order does not matter; the list is
        /// sorted before it is hashed.
        #[arg(long, value_delimiter = ',')]
        features: Vec<String>,
        /// The cargo profile.
        #[arg(long, default_value = "release")]
        profile: String,
        /// Print the per-input digests on stderr, so a moved key can be
        /// attributed to one of the five inputs instead of guessed at.
        #[arg(long)]
        explain: bool,
    },
    /// Per-lane first-attempt pass rate and chronic red, off the GitHub Actions
    /// API (#1020, D-1020-G3; re-homed from `scripts/ci/lane-health.mjs`).
    /// Nightly only — a pull request's verdict must not depend on api.github.com.
    LaneHealth {
        /// `owner/name`.
        #[arg(long, default_value = "srikanth235/centraid")]
        repo: String,
        /// Which workflow's runs to read.
        #[arg(long, default_value = "ci.yml")]
        workflow: String,
        /// How many runs on `main` to look back over.
        #[arg(long, default_value_t = 40)]
        runs: usize,
    },
    /// Measure the edit-run loop and print (or write) the compile-time ledger.
    Measure {
        /// Write the measurements into `contracts/ledgers/compile-time.json`.
        #[arg(long)]
        write: bool,
        /// Measure only these keys (comma-separated). Every key by default.
        ///
        /// The keys cost minutes each and two of them delete `target/`, so a
        /// re-measurement of one number must not force a re-measurement of all
        /// of them (#1020).
        #[arg(long, value_delimiter = ',')]
        only: Vec<String>,
    },
}

/// The four profiles, in ascending cost. Each is a superset of the one before.
#[derive(Copy, Clone, Eq, PartialEq, ValueEnum)]
pub enum Profile {
    /// The edit-run loop: format, lint, test, structural rules, ledgers.
    Local,
    /// What every pull request must satisfy. `local` plus supply chain, a
    /// release build, the v1 tree's TypeScript, and the budget.
    Pr,
    /// `pr` plus the v0 oracle suite and the device lanes.
    Nightly,
    /// `nightly` plus the restore drill and the VPS smoke.
    Release,
    /// The Kotlin/Gradle JVM suites: `:shared:jvmTest`, `:core:jvmTest` — a
    /// real ABI round trip against the real cdylib — and the generated-artifact
    /// drift check. NOT a superset of any other profile and not charged to
    /// `pr`: a different toolchain with a different cold cost, and one number
    /// answering for two build systems answers for neither (D-1020-B2-3).
    MobileJvm,
}

impl Profile {
    pub fn name(self) -> &'static str {
        match self {
            Profile::Local => "local",
            Profile::Pr => "pr",
            Profile::Nightly => "nightly",
            Profile::Release => "release",
            Profile::MobileJvm => "mobile-jvm",
        }
    }
}

/// The repository root — the directory holding the workspace `Cargo.toml`.
///
/// **Resolved AT RUN TIME, from the current directory.** It used to be
/// `env!("CARGO_MANIFEST_DIR")`, which is baked in when the binary is
/// COMPILED — and wave 3's lanes share one `CARGO_TARGET_DIR` because disk is
/// tight, so the cached binary belonged to whichever worktree compiled it last
/// and every path-based rule scanned THAT worktree. `sql-confinement`,
/// `no-listening-socket`, `abi-five-symbols` and `ts-static` are all
/// path-based, and the failure direction is **reports clean**, which is the
/// worst one: two lanes saw three different answers from the same command in
/// the same tree (#1020 wave 3, lane E finding 8 and lane F finding 1).
///
/// Three sources, in order, and the third says so out loud:
///
/// 1. `git rev-parse --show-toplevel` from the current directory. Right for a
///    linked worktree, a submodule checkout and a plain clone alike.
/// 2. Walking up from the current directory for the pair only the root carries
///    (`CONSTITUTION.md` and `Cargo.toml`). For a tree exported without
///    `.git`, and for a machine with no `git` on `PATH`.
/// 3. The baked manifest path, **with a warning on stderr**. `cargo run -p
///    xtask` from outside any checkout still works — the case the baked path
///    existed for — and a run that scores another tree can no longer happen
///    without printing the line that says it did.
fn repo_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(root) = git_toplevel(&cwd).filter(|root| is_repo_root(root)) {
        return root;
    }
    if let Some(root) = walk_up_to_root(&cwd) {
        return root;
    }
    let baked = baked_root();
    eprintln!(
        "xtask: WARNING no repository root at or above {} — falling back to the path baked in at \
         compile time ({}). Every path-based rule scans THAT tree, not this directory (#1020).",
        cwd.display(),
        baked.display()
    );
    baked
}

/// The manifest path cargo baked in, two levels up: `crates/xtask` → the root.
fn baked_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    match manifest.parent().and_then(std::path::Path::parent) {
        Some(root) => root.to_path_buf(),
        None => manifest,
    }
}

/// The two files only the repository root carries together.
fn is_repo_root(dir: &std::path::Path) -> bool {
    dir.join("CONSTITUTION.md").is_file() && dir.join("Cargo.toml").is_file()
}

fn git_toplevel(cwd: &std::path::Path) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn walk_up_to_root(cwd: &std::path::Path) -> Option<PathBuf> {
    let mut dir = cwd.to_path_buf();
    loop {
        if is_repo_root(&dir) {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let root = repo_root();
    let ok = match cli.command {
        Command::Gate {
            profile,
            cold,
            lane,
        } => match gate::run(profile, &root, cold, lane) {
            Ok(ok) => ok,
            Err(error) => {
                eprintln!("xtask: {error:#}");
                false
            }
        },
        Command::Rules => rules::print_report(&root),
        Command::RepoRoot => {
            println!("{}", root.display());
            true
        }
        Command::ArtifactKey {
            triple,
            mut features,
            profile,
            explain,
        } => {
            features.sort();
            features.dedup();
            match artifact::run(
                &root,
                &artifact::KeyInputs {
                    triple,
                    features,
                    profile,
                },
                explain,
            ) {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("xtask: {error:#}");
                    false
                }
            }
        }
        Command::LaneHealth {
            repo,
            workflow,
            runs,
        } => match ci::lane_health(&root, &repo, &workflow, runs) {
            Ok(result) => {
                println!("{}", result.line);
                for finding in &result.findings {
                    println!("  {finding}");
                }
                result.ok
            }
            Err(error) => {
                eprintln!("xtask: {error:#}");
                false
            }
        },
        Command::Measure { write, only } => match measure::run(&root, write, &only) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("xtask: {error:#}");
                false
            }
        },
    };
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod root_tests {
    use super::*;

    /// A fabricated second checkout is found from inside it, and NOT confused
    /// with the tree this test binary was compiled from.
    #[test]
    fn the_root_is_the_cwds_and_a_bare_directory_is_not_a_root() {
        let scratch =
            std::env::temp_dir().join(format!("xtask-root-{}-{}", std::process::id(), line!()));
        let nested = scratch.join("crates/xtask/src");
        std::fs::create_dir_all(&nested).expect("a scratch tree");
        assert!(
            walk_up_to_root(&nested).is_none(),
            "a directory tree with neither marker is not a repository root"
        );
        std::fs::write(scratch.join("CONSTITUTION.md"), "x").expect("a constitution");
        assert!(
            walk_up_to_root(&nested).is_none(),
            "CONSTITUTION.md alone is not the root: `Cargo.toml` is the other half"
        );
        std::fs::write(scratch.join("Cargo.toml"), "[workspace]\n").expect("a manifest");
        assert_eq!(
            walk_up_to_root(&nested).as_deref(),
            Some(scratch.as_path()),
            "the root is resolved by walking UP from the current directory"
        );
        assert_ne!(
            walk_up_to_root(&nested).as_deref(),
            Some(baked_root().as_path()),
            "and it is not the path baked in when this test binary was compiled"
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
