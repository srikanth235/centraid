pub mod candidate;
pub mod commits;
pub mod ops;
pub mod surfaces;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Subcommand;

#[derive(Subcommand)]
pub enum ReleaseCommand {
    /// Classify patch vs minor bump from commits since the last `v*` tag.
    Classify {
        #[arg(long)]
        require_candidate: bool,
        #[arg(long)]
        sha: Option<String>,
        #[arg(long)]
        allow_uncandidated: bool,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Print the release surface matrix.
    Matrix {
        #[arg(long)]
        json: bool,
        #[arg(long, value_delimiter = ',')]
        surfaces: Option<Vec<String>>,
    },
    /// Prepare a release (candidate check, clean tree, pr gate, bump classification).
    Prepare {
        #[arg(long)]
        allow_dirty: bool,
        #[arg(long)]
        skip_check: bool,
        #[arg(long)]
        allow_uncandidated: bool,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Stamp versions, commit and tag a release after maintainer authorization.
    Publish {
        #[arg(long)]
        version: String,
        #[arg(long)]
        issue: String,
        #[arg(long, value_delimiter = ',')]
        surfaces: Option<Vec<String>>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        beta: bool,
        #[arg(long, default_value = "1")]
        beta_n: String,
        #[arg(long)]
        push: bool,
    },
    /// Re-stamp `releaseDate` in a published updater YAML manifest.
    Restamp {
        #[arg(long)]
        hours: f64,
        #[arg(long)]
        yml: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
        #[arg(long)]
        dry_run: bool,
    },
    /// Sync root package.json version across workspace package.jsons.
    SyncVersions {
        #[arg(long)]
        version: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
    /// Report which release secret names are present in the environment.
    VerifySecrets {
        #[arg(long)]
        strict: bool,
    },
    /// Emit GitHub Release notes built from commits since the last tag.
    Notes {
        #[arg(long)]
        version: String,
        #[arg(long)]
        out: Option<PathBuf>,
    },
}

pub fn run(root: &Path, cmd: ReleaseCommand) -> Result<bool> {
    match cmd {
        ReleaseCommand::Classify {
            require_candidate,
            sha,
            allow_uncandidated,
            reason,
        } => ops::run_classify(
            root,
            require_candidate,
            sha.as_deref(),
            allow_uncandidated,
            reason.as_deref(),
        ),
        ReleaseCommand::Matrix { json, surfaces } => match surfaces::print_matrix(json, surfaces) {
            Ok(()) => Ok(true),
            Err(err) => {
                eprintln!("{err}");
                Ok(false)
            }
        },
        ReleaseCommand::Prepare {
            allow_dirty,
            skip_check,
            allow_uncandidated,
            reason,
        } => Ok(ops::run_prepare(
            root,
            allow_dirty,
            skip_check,
            allow_uncandidated,
            reason.as_deref(),
        )?
        .is_some()),
        ReleaseCommand::Publish {
            version,
            issue,
            surfaces,
            dry_run,
            beta,
            beta_n,
            push,
        } => Ok(ops::run_publish(
            root,
            &ops::PublishArgs {
                version,
                issue,
                surfaces,
                dry_run,
                beta,
                beta_n,
                push,
            },
        )?
        .is_some()),
        ReleaseCommand::Restamp {
            hours,
            yml,
            out,
            dry_run,
        } => {
            let src = fs::read_to_string(&yml)
                .with_context(|| format!("missing yml: {}", yml.display()))?;
            let (text, release_date) = ops::restamp_release_date(&src, hours, ops::now_epoch_ms())?;
            let dest = out.unwrap_or_else(|| yml.clone());
            if !dry_run {
                fs::write(&dest, text).with_context(|| format!("write {}", dest.display()))?;
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "yml": yml.display().to_string(),
                    "out": dest.display().to_string(),
                    "hours": hours,
                    "releaseDate": release_date,
                    "dryRun": dry_run,
                }))?
            );
            Ok(true)
        }
        ReleaseCommand::SyncVersions { version, dry_run } => {
            let report = ops::run_sync_versions(root, version.as_deref(), dry_run)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(true)
        }
        ReleaseCommand::VerifySecrets { strict } => ops::run_verify_secrets(strict),
        ReleaseCommand::Notes { version, out } => {
            ops::run_notes(root, &version, out.as_deref())?;
            Ok(true)
        }
    }
}
