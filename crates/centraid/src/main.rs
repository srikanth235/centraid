#![forbid(unsafe_code)]
//! `centraid` — the one binary (#1020, D-1020-C11).
//!
//! **One verb, `doctor`.** The vault is on the phone and the gateway is
//! `centraid-gateway` (`crates/gateway`), which installs its own service unit;
//! what is left here is what an operator runs over a vault file by hand
//! ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! **A subcommand that is not built yet FAILS.** Every verb whose
//! implementation lands in a later lane returns
//! [`ExitCode::NOT_YET_AVAILABLE`] (3) with the lane that owns it named in the
//! message — never a silent stub, and never a zero exit on work that did not
//! happen. Wave 2's lane D2 and lane R fill them in.
//!
//! See `README.md` for the subcommands, the exit codes, and the no-listener
//! claim.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

mod cmd;
mod run;

/// The exit codes, stated once. A script that wraps this binary branches on
/// these numbers, so they are as much of an interface as the subcommands.
pub mod exit {
    /// It worked.
    pub const OK: u8 = 0;
    /// The command ran and refused: a bad ticket, a device that is not
    /// enrolled, a vault that will not open.
    pub const REFUSED: u8 = 1;
    /// The arguments were wrong. clap's own code, kept rather than remapped so
    /// that `centraid --help`'s behaviour is the behaviour every clap binary
    /// has.
    pub const USAGE: u8 = 2;
    /// The verb exists and its implementation lands in a later lane. NEVER a
    /// silent stub (#1020, D-1020-C11).
    pub const NOT_YET_AVAILABLE: u8 = 3;
}

#[derive(Parser)]
#[command(
    name = "centraid",
    about = "Centraid: the operator-facing verbs over a vault directory (#1029)",
    version,
    long_about = None
)]
struct Cli {
    /// Log filter, e.g. `centraid=debug`. Diagnostics go to stderr and
    /// nothing else does, so a caller can parse stdout.
    #[arg(long, env = "CENTRAID_LOG", global = true)]
    log: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check a vault file and report. Read-only and lock-free, so it never
    /// changes the file it judges.
    Doctor {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Print the JSON report even when the vault is clean.
        #[arg(long)]
        json: bool,
    },
}

/// `centraid --version --json` prints the ARTIFACT IDENTITY (#1020 Artifacts,
/// D-1020-G2): the version, the git sha, the artifact digest, the vault schema
/// version, and whether this is a development build.
///
/// Intercepted before clap rather than modelled as a subcommand, because clap
/// owns `--version` and the shape `--version --json` is what `deploy/vps/
/// install.sh` and the release smoke read. A `centraid version --json`
/// subcommand would have been tidier inside this file and a second spelling for
/// everyone outside it.
fn version_json_requested() -> bool {
    let mut version = false;
    let mut json = false;
    for argument in std::env::args().skip(1) {
        match argument.as_str() {
            "--version" | "-V" => version = true,
            "--json" => json = true,
            _ => {}
        }
    }
    version && json
}

fn main() -> ExitCode {
    if version_json_requested() {
        println!(
            "{}",
            centraid_core::identity::ArtifactIdentity::current().to_json()
        );
        return ExitCode::from(exit::OK);
    }
    let cli = Cli::parse();
    run::install_tracing(cli.log.as_deref());

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("centraid: could not start the async runtime: {error}");
            return ExitCode::from(exit::REFUSED);
        }
    };

    let code = runtime.block_on(async move {
        match cli.command {
            Command::Doctor { data_dir, json } => {
                cmd::doctor::run(cmd::doctor::DoctorArgs { data_dir, json })
            }
        }
    });
    ExitCode::from(code)
}
