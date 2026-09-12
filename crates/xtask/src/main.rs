#![forbid(unsafe_code)]
//! `cargo xtask` — the v1 tree's only cross-cutting entrypoint (#1020).
//!
//! Rule two of this repository is "never compromise on tooling", and v1 is
//! three languages. Anything that has to hold across all of them cannot live in
//! any one of them, so it lives here: `cargo xtask gate --profile <local|pr|
//! nightly|release>` is the single command CI runs and the single command the
//! local loop runs. A fifth profile name, `mobile-jvm`, exists in the ledgers
//! and refuses to run until wave 3 lane E fills it (#1020, D-1020-B2-3). See `crates/xtask/README.md` for the profiles, the budgets,
//! where failure artifacts land, and the one thing this runner deliberately
//! does NOT do (governance — it has its own workflow).

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};

mod gate;
mod ledger;
mod measure;
mod rules;
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
    },
    /// Run only the structural rules (the cheap half of every profile).
    Rules,
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
    /// The Kotlin/Gradle JVM suites. A LEDGER PLACEHOLDER with no steps until
    /// wave 3 lane E lands them, and a refusal if you run it (D-1020-B2-3).
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
/// `cargo xtask` always runs the binary from the workspace root, but a bare
/// `cargo run -p xtask` from a subdirectory should still work, so the root is
/// derived from the manifest path cargo bakes in rather than from the cwd.
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    match manifest.parent().and_then(std::path::Path::parent) {
        Some(root) => root.to_path_buf(),
        None => manifest,
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let root = repo_root();
    let ok = match cli.command {
        Command::Gate { profile, cold } => match gate::run(profile, &root, cold) {
            Ok(ok) => ok,
            Err(error) => {
                eprintln!("xtask: {error:#}");
                false
            }
        },
        Command::Rules => rules::print_report(&root),
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
