//! `cargo xtask gate --profile <local|pr|nightly|release>`.
//!
//! One step list per profile, each step named, timed, and buffered — output is
//! printed only when the step fails, and every step prints exactly one line
//! whatever it does. That posture is copied from `scripts/ci/run-gates.mjs`,
//! which the repo already runs the TypeScript gates through, and from the one
//! sentence in it that matters: **a silent gate is not a gate.** Every step
//! runs even when an earlier one failed, so one pass tells you everything that
//! is wrong.
//!
//! There are exactly three verdicts per step and no fourth: `ok`, `FAIL`, and a
//! loud `SKIP` that names the command which turns it into a real run. A guarded
//! skip that could be mistaken for a pass is the failure mode
//! `scripts/security/rust-supply-chain.mjs` was written to avoid, and the
//! `deny` step below is the same posture: required in CI, loud-skipped locally.
//!
//! **Governance is not a step here.** `.governance/run.sh` runs in
//! `governance.yml` on every PR as its own required check; duplicating it would
//! charge the `pr` budget twice for one answer and give a failure two places to
//! be reported from.
//!
//! Failure artifacts land under `target/xtask/<profile>/<step>/` — the command,
//! its stdout and its stderr — and the step's one line names the directory.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};

use crate::Profile;
use crate::ledger;
use crate::rules;

/// The hardware class this container is, matching `tests/journeys.json`'s
/// vocabulary. Overridable so the self-hosted device runner can score itself.
pub const DEFAULT_HARDWARE: &str = "ci-linux-x64-4c";

/// Everything a step needs to know about the run it is part of.
pub struct Ctx {
    pub root: PathBuf,
    pub hardware: String,
    /// True under `CI`. A tool that is merely absent is a skip locally and an
    /// infrastructure failure in CI, because the workflow installs it.
    pub ci: bool,
    pub artifacts: PathBuf,
}

pub enum Outcome {
    /// Passed. Carries the one line that says what ran.
    Ok(String),
    /// Deliberately not run. Carries why, and the command that unblocks it.
    Skipped(String),
    /// Failed. Carries why, in one line.
    Failed(String),
}

type Runner = fn(&Ctx) -> Result<Outcome>;

pub struct Step {
    pub name: &'static str,
    pub run: Runner,
}

const fn step(name: &'static str, run: Runner) -> Step {
    Step { name, run }
}

/// The step list for a profile. Each profile is a superset of the one before —
/// stated as concatenation rather than as a copied list, so a step can never be
/// in `pr` and missing from `release`.
pub fn steps(profile: Profile) -> Vec<Step> {
    if profile == Profile::MobileJvm {
        // A ledger placeholder, not a runnable profile (D-1020-B2-3). Wave 3
        // lane E owns the Gradle steps and the measurement that sets its budget.
        return Vec::new();
    }
    let local = vec![
        step("fmt", |ctx| {
            process(ctx, "fmt", "cargo", &["fmt", "--all", "--check"])
        }),
        step("clippy", |ctx| {
            process(
                ctx,
                "clippy",
                "cargo",
                &[
                    "clippy",
                    "--workspace",
                    "--all-targets",
                    "--",
                    "-D",
                    "warnings",
                ],
            )
        }),
        step("test", run_tests),
        step("rules", run_rules),
        step("ledgers", run_ledgers),
    ];
    if profile == Profile::Local {
        return local;
    }
    let mut pr = local;
    pr.extend([
        step("buf", run_buf),
        step("deny", run_deny),
        step("ci-policy", run_ci_policy),
        step("secrets", run_secrets),
        step("osv", run_osv),
        step("release-build", run_release_build),
        step("ts-static", run_ts_static),
    ]);
    if profile == Profile::Pr {
        return pr;
    }
    let mut nightly = pr;
    nightly.extend([step("v0-oracle", run_v0_oracle), step("device-lanes", |_| {
        Ok(Outcome::Skipped(
            "not runnable on a hosted Linux runner: ios-transfer-experiment, android-macrobenchmark, ios-xctest-metrics, battery-per-background-pass. They need the self-hosted macOS runner with one iPhone and one Android attached (#1020 wave 3 lane G / open question 13)".to_owned(),
        ))
    })]);
    if profile == Profile::Nightly {
        return nightly;
    }
    let mut release = nightly;
    release.extend([
        step("restore-drill", run_restore_drill),
        step("vps-smoke", |_| {
            Ok(Outcome::Failed(
                "not implemented: lands in wave 3 lane G (release smoke on a clean VPS from the Docker image)".to_owned(),
            ))
        }),
    ]);
    release
}

/// Was the profile's own build output on disk before the run started?
///
/// The `local` budget is the developer's feedback time after an edit, and the
/// edit-run loop runs on a tree that has been built before (D-1020-B2-1). The
/// first run after `cargo clean` or a fresh clone is a different measurement
/// with its own ledgered ceiling, so the two are told apart rather than averaged
/// into a number that is wrong for both.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum Tree {
    Warm,
    Cold,
}

/// The workspace members' package names, read off `crates/*/Cargo.toml` and
/// `crates/apps/*/Cargo.toml` — the two globs the root manifest lists.
pub fn member_packages(root: &Path) -> Vec<String> {
    let mut names = Vec::new();
    for parent in ["crates", "crates/apps"] {
        let Ok(entries) = fs::read_dir(root.join(parent)) else {
            continue;
        };
        for entry in entries.flatten() {
            let manifest = entry.path().join("Cargo.toml");
            let Ok(text) = fs::read_to_string(&manifest) else {
                continue;
            };
            let mut in_package = false;
            for line in text.lines() {
                let line = line.trim();
                if line.starts_with('[') {
                    in_package = line == "[package]";
                    continue;
                }
                if let Some(rest) = line.strip_prefix("name")
                    && in_package
                    && let Some(value) = rest.split('=').nth(1)
                {
                    names.push(value.trim().trim_matches('"').to_owned());
                    break;
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

/// Warm iff EVERY workspace member has a **linkable or runnable** artifact in
/// `target/debug/deps` — a `.rlib` or an executable with no extension.
///
/// The discriminator is deliberately not "`target/debug` exists" and not
/// "`target/debug/deps` is non-empty": `cargo check` and `cargo clippy` produce
/// `.rmeta` only, so a tree that has merely been checked would claim to be warm
/// for a profile whose `test` step still has to compile and link every crate
/// from scratch — which is exactly how the 120 s promise would be gamed. A
/// *stale* incremental tree does read as warm, on purpose: a tree whose sources
/// moved since the last build is the tree the edit-run loop runs on, and
/// rebuilding that delta is the thing the budget is promising.
///
/// Returns the state and the one line that says how it was decided.
pub fn tree_state(root: &Path, forced_cold: bool) -> (Tree, String) {
    if forced_cold {
        return (
            Tree::Cold,
            "cold — `--cold` was passed, so the run is scored as a first build whatever is on disk"
                .to_owned(),
        );
    }
    let members = member_packages(root);
    if members.is_empty() {
        return (
            Tree::Cold,
            "cold — no workspace member manifests were readable under crates/, so nothing can be known to be built".to_owned(),
        );
    }
    let deps = root.join("target/debug/deps");
    let names: Vec<String> = match fs::read_dir(&deps) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    let missing: Vec<&String> = members
        .iter()
        .filter(|member| !has_linked_artifact(&names, member))
        .collect();
    if missing.is_empty() {
        return (
            Tree::Warm,
            format!(
                "warm — all {} workspace member(s) have a linked artifact in target/debug/deps",
                members.len()
            ),
        );
    }
    (
        Tree::Cold,
        format!(
            "cold — {} of {} workspace member(s) have no linked artifact in target/debug/deps (first: {}); an `.rmeta` from a previous `cargo check` does not count",
            missing.len(),
            members.len(),
            missing[0]
        ),
    )
}

/// Is there a `lib<crate>-*.rlib` or an extensionless `<crate>-*` executable
/// among `names`? Hyphens in a package name are underscores in an artifact name.
fn has_linked_artifact(names: &[String], member: &str) -> bool {
    let snake = member.replace('-', "_");
    let library = format!("lib{snake}-");
    let binary = format!("{snake}-");
    names.iter().any(|name| {
        (name.starts_with(&library) && name.ends_with(".rlib"))
            || (name.starts_with(&binary) && !name[binary.len()..].contains('.'))
    })
}

/// Run a profile. Returns `true` when every step passed inside its budget.
pub fn run(profile: Profile, root: &Path, forced_cold: bool) -> Result<bool> {
    let hardware =
        std::env::var("CENTRAID_GATE_HARDWARE").unwrap_or_else(|_| DEFAULT_HARDWARE.to_owned());
    if profile == Profile::MobileJvm {
        println!(
            "xtask gate — profile mobile-jvm · hardware {hardware}\n\n  REFUSED the `mobile-jvm` profile is a ledger placeholder with no steps. Its `budgetSeconds` in {} and `kotlinNativeLinkSeconds` in {} are both null, and wave 3 lane E — which lands the Kotlin Multiplatform shared module and its Gradle JVM suites — measures them and sets them (#1020, D-1020-B2-3). Running it here would report green for a suite that does not exist",
            ledger::BUDGETS,
            ledger::COMPILE_TIME
        );
        return Ok(false);
    }
    let ctx = Ctx {
        root: root.to_path_buf(),
        hardware: hardware.clone(),
        ci: std::env::var_os("CI").is_some(),
        artifacts: root.join("target/xtask").join(profile.name()),
    };
    let budget = ledger::budget_seconds(root, profile.name(), &hardware)?;
    let (tree, why) = tree_state(root, forced_cold);

    println!(
        "xtask gate — profile {} · hardware {hardware} · budget {}\n  tree {why}",
        profile.name(),
        budget.map_or_else(
            || "unbounded".to_owned(),
            |seconds| format!("{seconds:.0}s")
        ),
    );

    let mut results: Vec<(&'static str, Duration, Outcome)> = Vec::new();
    for entry in steps(profile) {
        let started = Instant::now();
        let outcome =
            (entry.run)(&ctx).unwrap_or_else(|error| Outcome::Failed(format!("{error:#}")));
        let elapsed = started.elapsed();
        println!("  {}", line(entry.name, elapsed, &outcome));
        results.push((entry.name, elapsed, outcome));
    }

    let total: Duration = results.iter().map(|(_, elapsed, _)| *elapsed).sum();
    println!("\n  {:<16} {:>8}", "step", "seconds");
    for (name, elapsed, _) in &results {
        println!("  {name:<16} {:>8.1}", elapsed.as_secs_f64());
    }
    println!("  {:<16} {:>8.1}", "TOTAL", total.as_secs_f64());

    let failed: Vec<&str> = results
        .iter()
        .filter(|(_, _, outcome)| matches!(outcome, Outcome::Failed(_)))
        .map(|(name, _, _)| *name)
        .collect();
    let mut ok = failed.is_empty();

    if !score(profile, tree, total.as_secs_f64(), budget, &ctx) {
        ok = false;
    }

    if failed.is_empty() {
        println!("\ngate {}: PASS", profile.name());
    } else {
        println!("\ngate {}: FAIL — {}", profile.name(), failed.join(", "));
        for (name, _, outcome) in &results {
            if let Outcome::Failed(detail) = outcome {
                println!("  {name}: {detail}");
            }
        }
    }
    Ok(ok)
}

/// The `compile-time.json` key a cold `local` run is charged against.
pub const COLD_LOCAL_KEY: &str = "coldLocalProfileSeconds";

/// Score a profile's total against the number that applies to the tree it ran
/// on, print the one line that says which, and return whether it held.
///
/// Only `local` has a cold ceiling of its own (D-1020-B2-1). Every other profile
/// runs in CI on a runner that has never seen this workspace, so a cold tree is
/// its NORMAL case and its `budgetSeconds` has to hold cold or it is not a
/// budget — the tree state is printed for those and changes nothing. A cold
/// `local` run is not let off: it is charged against `coldLocalProfileSeconds`,
/// its own down-only ledger entry, and a cold run with no ceiling stated fails
/// rather than passing unscored, because "cold" must never be the answer that
/// makes a slow gate green.
fn score(profile: Profile, tree: Tree, total: f64, budget: Option<f64>, ctx: &Ctx) -> bool {
    if profile == Profile::Local && tree == Tree::Cold {
        let ceiling = ledger::compile_time_ceiling(&ctx.root, &ctx.hardware, COLD_LOCAL_KEY);
        return match ceiling {
            Some(ceiling) if total > ceiling => {
                println!(
                    "\n  BUDGET cold — the `local` profile took {total:.1}s against the {ceiling:.0}s `{COLD_LOCAL_KEY}` ceiling in {}. A first build is not charged the warm feedback-time budget, and it is not unbudgeted either (#1020, D-1020-B2-1)",
                    ledger::COMPILE_TIME
                );
                false
            }
            Some(ceiling) => {
                println!(
                    "  BUDGET cold ok — {total:.1}s of the {ceiling:.0}s `{COLD_LOCAL_KEY}` ceiling in {}; the warm {} budget was not the number scored",
                    ledger::COMPILE_TIME,
                    budget.map_or_else(
                        || "unbounded".to_owned(),
                        |seconds| format!("{seconds:.0}s")
                    )
                );
                true
            }
            None => {
                println!(
                    "\n  BUDGET cold — the `local` profile took {total:.1}s and {} states no `{COLD_LOCAL_KEY}` ceiling for {}. An unscored run is not a pass: measure it with `cargo xtask measure --only {COLD_LOCAL_KEY} --write` (#1020)",
                    ledger::COMPILE_TIME,
                    ctx.hardware
                );
                false
            }
        };
    }
    let Some(seconds) = budget else {
        return true;
    };
    let state = if tree == Tree::Cold {
        " (on a cold tree, which is this profile's normal case in CI — the budget holds cold or it is not a budget)"
    } else {
        ""
    };
    if total > seconds {
        println!(
            "\n  BUDGET the `{}` profile took {total:.1}s against a {seconds:.0}s budget{state}. The budget is the product's feedback-time promise, not a target — either the step above it got slower or the profile grew a step it should not carry ({}, #1020)",
            profile.name(),
            ledger::BUDGETS
        );
        return false;
    }
    println!("  BUDGET ok — {total:.1}s of {seconds:.0}s{state}");
    true
}

fn line(name: &str, elapsed: Duration, outcome: &Outcome) -> String {
    let seconds = elapsed.as_secs_f64();
    match outcome {
        Outcome::Ok(detail) => format!("ok    {name:<16} {seconds:>6.1}s  {detail}"),
        Outcome::Skipped(detail) => format!("SKIP  {name:<16} {seconds:>6.1}s  {detail}"),
        Outcome::Failed(detail) => format!("FAIL  {name:<16} {seconds:>6.1}s  {detail}"),
    }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/// THE RESTORE DRILL (#1020, wave 2 lane R, D-1020-R7).
///
/// The acceptance box is *"the restore drill runs in CI"*, and this is the step
/// that makes it true. It runs `crates/centraid`'s `restore_drill` integration
/// test, which:
///
/// - founds a vault, enrols a seat and writes commits;
/// - takes a generation (a complete base copy + the sealed WAL tail + a
///   manifest) and a password-wrapped recovery kit;
/// - **deletes the live data directory, keys and all**;
/// - runs the real `centraid recover` binary into a fresh directory;
/// - proves `restore_check` is clean and every row is back, table by table;
/// - proves the old seat is told `RebootstrapRequired{epoch-mismatch}`,
///   re-pairs, re-bootstraps and converges.
///
/// It is a `cargo test` invocation rather than logic in this file on purpose:
/// the drill needs the vault crate and the binary, and this runner is on the
/// edit-run loop with three dependencies. `--nocapture` is passed so the
/// drill's own wall-clock line reaches the artifact log, and the step records
/// its own elapsed time beside it.
///
/// **It must FAIL, never skip.** A release profile that could pass without the
/// drill would report "release is green" for a release nobody proved
/// restorable.
fn run_restore_drill(ctx: &Ctx) -> Result<Outcome> {
    let started = Instant::now();
    let outcome = process(
        ctx,
        "restore-drill",
        "cargo",
        &[
            "test",
            "-p",
            "centraid",
            "--test",
            "restore_drill",
            "--",
            "--nocapture",
        ],
    )?;
    let seconds = started.elapsed().as_secs_f64();
    if !matches!(outcome, Outcome::Ok(_)) {
        return Ok(outcome);
    }
    // The wall clock, as evidence rather than as a ceiling. There is no
    // `restoreDrillSeconds` slot in `contracts/ledgers/gate-budgets.json` —
    // the release profile's budget is `null` by ruling — so the number is
    // written to the artifact directory and quoted in the step's line. A
    // ceiling invented here would be a number this lane ratcheted into a
    // down-only ledger on the strength of one run.
    let dir = ctx.artifacts.join("restore-drill");
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("timing.json"),
        format!(
            "{{\n  \"hardware\": \"{}\",\n  \"restoreDrillSeconds\": {seconds:.1}\n}}\n",
            ctx.hardware
        ),
    )?;
    Ok(Outcome::Ok(format!(
        "restore, re-pair and converge in {seconds:.1}s (release budget is unbounded by ruling) — evidence: {}",
        display_relative(&ctx.root, &dir)
    )))
}

/// Run a command, buffered. On failure the whole output is written under
/// `target/xtask/<profile>/<step>/` and the returned line names it.
fn process(ctx: &Ctx, step: &str, program: &str, args: &[&str]) -> Result<Outcome> {
    let label = format!("{program} {}", args.join(" "));
    let output = Command::new(program)
        .args(args)
        .current_dir(&ctx.root)
        .output()
        .with_context(|| format!("spawn `{label}`"))?;
    if output.status.success() {
        return Ok(Outcome::Ok(label));
    }
    let dir = ctx.artifacts.join(step);
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    fs::write(dir.join("command.txt"), format!("{label}\n"))?;
    fs::write(dir.join("stdout.log"), &output.stdout)?;
    fs::write(dir.join("stderr.log"), &output.stderr)?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let why = stderr
        .lines()
        .rev()
        .find(|candidate| !candidate.trim().is_empty())
        .unwrap_or("(no stderr)");
    let why: String = why.chars().take(160).collect();
    Ok(Outcome::Failed(format!(
        "`{label}` exited {} — {why} · artifact: {}",
        output.status.code().unwrap_or(-1),
        display_relative(&ctx.root, &dir)
    )))
}

/// Is `cargo <subcommand>` on PATH? Classified from the text, not the exit code
/// alone, exactly as `rust-supply-chain.mjs` does: cargo reports a missing
/// subcommand differently across versions.
fn cargo_subcommand_available(root: &Path, subcommand: &str) -> bool {
    let Ok(output) = Command::new("cargo")
        .args([subcommand, "--version"])
        .current_dir(root)
        .output()
    else {
        return false;
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if text.to_lowercase().contains("no such command") {
        return false;
    }
    output.status.success()
}

/// `cargo nextest run` when it is installed, `cargo test` otherwise. Which one
/// ran is in the step's line, because "the tests passed" means something
/// different under a runner that reports per-test timings and one that does not.
fn run_tests(ctx: &Ctx) -> Result<Outcome> {
    if cargo_subcommand_available(&ctx.root, "nextest") {
        process(ctx, "test", "cargo", &["nextest", "run", "--workspace"])
    } else {
        process(ctx, "test", "cargo", &["test", "--workspace"])
    }
}

fn run_rules(ctx: &Ctx) -> Result<Outcome> {
    let reports = rules::all(&ctx.root);
    let findings: usize = reports.iter().map(|report| report.findings.len()).sum();
    let applied = reports
        .iter()
        .filter(|report| matches!(report.state, rules::RuleState::Applied(_)))
        .count();
    let pending = reports.len() - applied;
    let block = rules::findings_block(&reports);
    if findings == 0 {
        print!("{}", indent(&block));
        return Ok(Outcome::Ok(format!(
            "{applied} rule(s) applied, {pending} pending their subject"
        )));
    }
    let dir = ctx.artifacts.join("rules");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("findings.txt"), &block)?;
    print!("{}", indent(&block));
    Ok(Outcome::Failed(format!(
        "{findings} structural finding(s) · artifact: {}",
        display_relative(&ctx.root, &dir)
    )))
}

fn run_ledgers(ctx: &Ctx) -> Result<Outcome> {
    let verdict = ledger::check(&ctx.root)?;
    if verdict.findings.is_empty() {
        return Ok(Outcome::Ok(format!(
            "{} ledger(s) hold against {}",
            verdict.checked.len(),
            &verdict.base[..verdict.base.len().min(8)]
        )));
    }
    let dir = ctx.artifacts.join("ledgers");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("findings.txt"), verdict.findings.join("\n"))?;
    for finding in &verdict.findings {
        println!("        {finding}");
    }
    Ok(Outcome::Failed(format!(
        "{} ledger finding(s) against {} · artifact: {}",
        verdict.findings.len(),
        &verdict.base[..verdict.base.len().min(8)],
        display_relative(&ctx.root, &dir)
    )))
}

/// The schema's compatibility promise (#1020 Compatibility, D-1020-C5).
///
/// Two commands, and the second one runs more than once. `buf lint` over both
/// modules, then `buf breaking` against the PR base **and against every
/// released tag inside the version window** — `N = 3` minors, open question 4 —
/// because the promise #1020 makes is to seats that update on their own
/// schedule, and a seat in the field is running a TAG, not the PR base. Checking
/// only the previous commit would let a field be renamed in two commits and
/// pass both.
///
/// Required in CI, loud-skipped locally, same posture as `deny`.
///
/// One case needs naming or it looks like a hole: when the BASE carries no
/// `.proto` files at all, buf exits non-zero with `had no .proto files`. That is
/// this step's answer on the commit that introduces the schema, and there is
/// nothing there to break — so it is reported as a pass whose line SAYS the base
/// was empty. It stops happening the moment `main` carries the tree, and the
/// alternative (failing) would make the schema's first commit unmergeable.
fn run_buf(ctx: &Ctx) -> Result<Outcome> {
    const INSTALL: &str = "install the pinned buf release (gate.yml does): curl -sSL https://github.com/bufbuild/buf/releases/download/v1.61.0/buf-Linux-x86_64 -o ~/.local/bin/buf && chmod +x ~/.local/bin/buf";
    const SUBDIR: &str = "subdir=crates/api-proto/proto";

    if !ctx.root.join("buf.yaml").is_file() {
        return Ok(Outcome::Skipped(
            "no buf.yaml — the schema workspace lands in wave 2 lane C (#1020)".to_owned(),
        ));
    }
    if !binary_available("buf") {
        if ctx.ci {
            return Ok(Outcome::Failed(format!(
                "`buf` is not on PATH and this is CI, where the workflow installs it — a missing binary here is an infrastructure failure, not a skip. {INSTALL}"
            )));
        }
        return Ok(Outcome::Skipped(format!(
            "`buf` is not on PATH — the lint rules and the COMPATIBILITY PROMISE of centraid.core.v1 were NOT checked. {INSTALL}"
        )));
    }

    if let Outcome::Failed(detail) = process(ctx, "buf", "buf", &["lint"])? {
        return Ok(Outcome::Failed(detail));
    }

    let mut against: Vec<String> = vec![format!(".git#branch=main,{SUBDIR}")];
    let tags = window_tags(&ctx.root);
    for tag in &tags {
        against.push(format!(".git#tag={tag},{SUBDIR}"));
    }

    let mut empty_bases = 0usize;
    for base in &against {
        let outcome = process(ctx, "buf", "buf", &["breaking", "--against", base])?;
        if let Outcome::Failed(detail) = outcome {
            if base_carries_no_schema(ctx, "buf") {
                empty_bases += 1;
                continue;
            }
            return Ok(Outcome::Failed(format!(
                "buf breaking against {base}: {detail}"
            )));
        }
    }

    let window = if tags.is_empty() {
        "0 tags in window (no `v*` tag exists yet for v1)".to_owned()
    } else {
        format!("{} tag(s) in window: {}", tags.len(), tags.join(", "))
    };
    let empty = if empty_bases == 0 {
        String::new()
    } else {
        format!(
            " — {empty_bases} base(s) carry no .proto files yet, so there was nothing there to break"
        )
    };
    Ok(Outcome::Ok(format!(
        "buf lint + breaking against {} base(s): main, {window}{empty}",
        against.len()
    )))
}

/// The last `N = 3` minor releases, newest first — the version window from
/// #1020's Compatibility section (open question 4). Tags are `v<major>.<minor>.
/// <patch>`; one tag per minor, the highest patch, because a seat in the field
/// runs the newest patch of its minor.
fn window_tags(root: &Path) -> Vec<String> {
    const WINDOW: usize = 3;
    let Ok(output) = Command::new("git")
        .args(["tag", "--list", "v*"])
        .current_dir(root)
        .output()
    else {
        return Vec::new();
    };
    let mut minors: Vec<((u32, u32), (u32, String))> = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let tag = line.trim();
        let Some(rest) = tag.strip_prefix('v') else {
            continue;
        };
        // A prerelease or build suffix is not a released tag.
        if rest.contains('-') || rest.contains('+') {
            continue;
        }
        let parts: Vec<&str> = rest.split('.').collect();
        if parts.len() != 3 {
            continue;
        }
        let Ok(major) = parts[0].parse::<u32>() else {
            continue;
        };
        let Ok(minor) = parts[1].parse::<u32>() else {
            continue;
        };
        let Ok(patch) = parts[2].parse::<u32>() else {
            continue;
        };
        match minors
            .iter_mut()
            .find(|(series, _)| *series == (major, minor))
        {
            Some((_, held)) if held.0 < patch => *held = (patch, tag.to_owned()),
            Some(_) => {}
            None => minors.push(((major, minor), (patch, tag.to_owned()))),
        }
    }
    minors.sort_by(|left, right| right.0.cmp(&left.0));
    minors
        .into_iter()
        .take(WINDOW)
        .map(|(_, (_, tag))| tag)
        .collect()
}

/// Did the LAST `buf` failure say the base had no `.proto` files? Read off the
/// artifact the step just wrote, so the classification is over what buf actually
/// printed and not over a guess about the tree.
fn base_carries_no_schema(ctx: &Ctx, step: &str) -> bool {
    let dir = ctx.artifacts.join(step);
    for name in ["stderr.log", "stdout.log"] {
        if let Ok(text) = fs::read_to_string(dir.join(name))
            && text.contains("had no .proto files")
        {
            return true;
        }
    }
    false
}

/// The Rust supply chain. Required in CI (the workflow installs the binary, so
/// a missing one there is infrastructure failure), loud-skipped locally.
fn run_deny(ctx: &Ctx) -> Result<Outcome> {
    const INSTALL: &str = "cargo install cargo-deny --locked";
    if cargo_subcommand_available(&ctx.root, "deny") {
        return process(
            ctx,
            "deny",
            "cargo",
            &["deny", "--all-features", "--config", "deny.toml", "check"],
        );
    }
    if ctx.ci {
        return Ok(Outcome::Failed(format!(
            "cargo-deny is not on PATH and this is CI, where the workflow installs it — a missing binary here is an infrastructure failure, not a skip. `{INSTALL}`"
        )));
    }
    Ok(Outcome::Skipped(format!(
        "cargo-deny is not on PATH — licences, banned crates and unknown registries were NOT checked. `{INSTALL}`"
    )))
}

/// Is `program` on PATH? Spawn success is the signal, not exit status: some of
/// these tools spell their version flag differently and one of them exits
/// non-zero for it, but only a missing binary fails to spawn at all.
fn binary_available(program: &str) -> bool {
    Command::new(program).arg("--version").output().is_ok()
}

/// An external binary the repo pins but does not vendor. Required in CI, where
/// the workflow installs it; loud-skipped locally with the install command.
/// Same three-outcomes-and-no-fourth contract as `deny`.
fn external(
    ctx: &Ctx,
    step: &str,
    program: &str,
    args: &[&str],
    covers: &str,
    install: &str,
) -> Result<Outcome> {
    if binary_available(program) {
        return process(ctx, step, program, args);
    }
    Ok(missing_binary(ctx, program, covers, install))
}

/// The verdict for an external binary that is not installed: an infrastructure
/// failure in CI (the workflow installs it) and a loud skip locally. Shared with
/// the steps that cannot go through `external` because they classify their own
/// report rather than their exit code.
fn missing_binary(ctx: &Ctx, program: &str, covers: &str, install: &str) -> Outcome {
    if ctx.ci {
        return Outcome::Failed(format!(
            "`{program}` is not on PATH and this is CI, where the workflow installs it — a missing binary here is an infrastructure failure, not a skip. {install}"
        ));
    }
    Outcome::Skipped(format!(
        "`{program}` is not on PATH — {covers} was NOT checked. {install}"
    ))
}

/// THE REPO'S OWN CI POLICY, which is neither v0's nor v1's.
///
/// #1020 rules v0's gates off pull requests, and these four are not v0 gates:
/// they are standing checks over `.github/**` and `tests/path-filter-ledger.json`
/// — that every third-party action is SHA-pinned, that every job is bounded,
/// that exactly one workflow listens on open-PR events, that a new workflow
/// carries an egress policy, and that no tracked directory merges unexercised.
/// They ran in `ci.yml`'s `static` and `gates` jobs on every PR. Taking the
/// `pull_request:` trigger off that file would have taken them off PRs too,
/// which would be weakening a gate rather than moving one — so they move HERE,
/// into the gate that replaced it. They are the gates that guard this very
/// workflow, and they cost under a second.
fn run_ci_policy(ctx: &Ctx) -> Result<Outcome> {
    const SCRIPTS: [&str; 3] = ["lint:workflow-pins", "lint:ci-egress", "lint:path-filters"];
    for script in SCRIPTS {
        let outcome = process(ctx, "ci-policy", "bun", &["run", script])?;
        if let Outcome::Failed(detail) = outcome {
            return Ok(Outcome::Failed(detail));
        }
    }
    // actionlint validates syntax and expressions, which the three scripts above
    // deliberately do not model. `ci.yml` runs it through a pinned container
    // action; here it is a pinned binary the workflow installs.
    let linted = external(
        ctx,
        "actionlint",
        "actionlint",
        &["-color"],
        "workflow syntax and expressions",
        "install the pinned release from github.com/rhysd/actionlint (gate.yml does)",
    )?;
    Ok(match linted {
        Outcome::Ok(_) => Outcome::Ok(format!("{} + actionlint", SCRIPTS.join(", "))),
        other => other,
    })
}

/// Secret scanning over the working tree (#671). Unfiltered, because any pull
/// request can introduce a secret — which is also why it cannot be left behind
/// in a workflow that no longer runs on pull requests.
///
/// INHERITED RED, named rather than hidden (D-1020-B1): this step is red on the
/// tree as it stands, because `packages/model-runtime/LICENSES.md` trips the
/// `generic-api-key` rule — a licence text, arrived with #1011/#1012. The fix is
/// the owner's: a reasoned allowlist row in `.gitleaks.toml` naming the file, or
/// moving the offending string. It is deliberately NOT fixed from here, because
/// a gate whose first act is to widen its own allowlist has gated nothing. A
/// gate that stops reporting because its target is red today would be a
/// weakening, which is why the step is here and red rather than absent.
///
/// **The scan is over the repository's files, not over its build output**
/// (D-1020-B2-5). `--no-git` is what gives the step its working-tree coverage —
/// an uncommitted secret is exactly what a pre-merge scan is for — but it also
/// makes gitleaks walk `target/` and `node_modules/`, and once the Rust
/// workspace is built that walk reports six findings inside `.rmeta` files,
/// every one of them a PEM header in `pem-rfc7468`/`pkcs8` doc strings vendored
/// through iroh. gitleaks 8.30 has no `--exclude-path` and no `.gitignore`
/// support (`gitleaks dir --help`; the only `gitignore` string in the binary is
/// a stopword), and its one exclusion mechanism is the config allowlist, which
/// is the file this step exists to keep honest.
///
/// So the step keeps ONE unfiltered scan and classifies gitleaks' own JSON
/// report afterwards: a finding is dropped only when **git itself** says the
/// file is not part of the repository — `git check-ignore` matches it and `git
/// ls-files` does not track it. That is not an allowlist of secret patterns, it
/// is the answer to "is this a file we wrote?", and it cannot hide a tracked
/// file: `git check-ignore` honours the index, so a tracked file is never
/// reported as ignored, and the tracked-file probe is belt and braces over that.
/// Both counts are printed, so the dropped set is never silent.
///
/// The alternative considered and rejected was one `gitleaks dir` invocation per
/// non-ignored top-level entry (71 of them here): measured at 46.5 s against
/// 2.7 s for the single scan, because gitleaks pays its ruleset compile per
/// process. A 17× slower secrets step charged to the `pr` budget buys nothing
/// the report filter does not already give.
fn run_secrets(ctx: &Ctx) -> Result<Outcome> {
    const COVERS: &str = "the working tree for high-entropy and non-provider secret patterns";
    const INSTALL: &str = "install the pinned gitleaks release (gate.yml does)";
    if !binary_available("gitleaks") {
        return Ok(missing_binary(ctx, "gitleaks", COVERS, INSTALL));
    }
    let dir = ctx.artifacts.join("secrets");
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let report = dir.join("report.json");
    let report_arg = report.to_string_lossy().into_owned();
    let args = [
        "detect",
        "--source",
        ".",
        "--no-git",
        "--config",
        ".gitleaks.toml",
        "--redact",
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        &report_arg,
    ];
    let output = Command::new("gitleaks")
        .args(args)
        .current_dir(&ctx.root)
        .output()
        .context("spawn `gitleaks detect`")?;
    fs::write(
        dir.join("command.txt"),
        format!("gitleaks {}\n", args.join(" ")),
    )?;
    fs::write(dir.join("stderr.log"), &output.stderr)?;
    // gitleaks exits 1 when it found something and something else when it could
    // not run at all. Only the second is this step failing to answer, and it is
    // reported as such rather than as "no secrets".
    let code = output.status.code().unwrap_or(-1);
    if code != 0 && code != 1 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let why: String = stderr
            .lines()
            .rev()
            .find(|candidate| !candidate.trim().is_empty())
            .unwrap_or("(no stderr)")
            .chars()
            .take(160)
            .collect();
        return Ok(Outcome::Failed(format!(
            "`gitleaks detect` exited {code} without producing a verdict — {why} · artifact: {}",
            display_relative(&ctx.root, &dir)
        )));
    }
    let files = report_files(&report)?;
    let (in_repo, dropped) = split_by_repository_membership(&ctx.root, &files);
    let aside = if dropped.is_empty() {
        String::new()
    } else {
        format!(
            "; {} finding(s) dropped in files .gitignore excludes and git does not track (build output, e.g. {})",
            dropped.len(),
            dropped[0]
        )
    };
    if in_repo.is_empty() {
        return Ok(Outcome::Ok(format!(
            "gitleaks over the working tree: 0 finding(s) in repository files{aside}"
        )));
    }
    fs::write(
        dir.join("findings.txt"),
        format!("{}\n", in_repo.join("\n")),
    )?;
    Ok(Outcome::Failed(format!(
        "{} secret finding(s) in repository files (first: {}){aside} · artifact: {}",
        in_repo.len(),
        in_repo[0],
        display_relative(&ctx.root, &dir)
    )))
}

/// The `File` of every finding in a gitleaks JSON report, in report order.
///
/// A report gitleaks did not write (it writes none when it found nothing) is an
/// empty finding list, not an error.
fn report_files(report: &Path) -> Result<Vec<String>> {
    let Ok(text) = fs::read_to_string(report) else {
        return Ok(Vec::new());
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let findings: Vec<serde_json::Value> =
        serde_json::from_str(&text).context("the gitleaks JSON report did not parse")?;
    Ok(findings
        .iter()
        .map(|finding| {
            finding
                .get("File")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("(no File field)")
                .replace('\\', "/")
        })
        .collect())
}

/// Split finding paths into (part of the repository, build output).
///
/// A path is build output only when `git check-ignore` matches it AND
/// `git ls-files` does not track it. Anything git cannot classify — including
/// the case where git is not runnable at all — stays in the repository half, so
/// a broken git makes the step noisier rather than blinder.
fn split_by_repository_membership(root: &Path, files: &[String]) -> (Vec<String>, Vec<String>) {
    let mut in_repo = Vec::new();
    let mut dropped = Vec::new();
    for file in files {
        if git_says_ignored(root, file) && !git_says_tracked(root, file) {
            dropped.push(file.clone());
        } else {
            in_repo.push(file.clone());
        }
    }
    (in_repo, dropped)
}

fn git_says_ignored(root: &Path, file: &str) -> bool {
    Command::new("git")
        .args(["check-ignore", "--quiet", "--", file])
        .current_dir(root)
        .output()
        .is_ok_and(|output| output.status.success())
}

fn git_says_tracked(root: &Path, file: &str) -> bool {
    Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", file])
        .current_dir(root)
        .output()
        .is_ok_and(|output| output.status.success())
}

/// The full lockfile advisory inventory (#671), through the repo's own script so
/// the CRITICAL-only threshold and the report stay in one place.
///
/// INHERITED RED, on the same terms (D-1020-B1): `astro@7.1.5` in `bun.lock`
/// carries a CRITICAL (score 9.8). The fix is a dependency bump, which is a
/// change outside #1020's scope and is the second owner hand-off. Nothing was
/// added to `osv-scanner.toml`.
fn run_osv(ctx: &Ctx) -> Result<Outcome> {
    if !binary_available("osv-scanner") {
        return external(
            ctx,
            "osv",
            "osv-scanner",
            &["--version"],
            "bun.lock against the OSV database",
            "install the pinned osv-scanner release (gate.yml does)",
        );
    }
    process(ctx, "osv", "node", &["scripts/ci/osv-lockfile-scan.mjs"])
}

/// The release build, scored against the compile-time ledger.
///
/// The measurement is written as evidence and compared with the ledger's
/// ceiling; it is never written BACK into the ledger. `cargo xtask measure
/// --write` owns that, so a gate run cannot ratchet its own ceiling upwards by
/// observing a slow day.
fn run_release_build(ctx: &Ctx) -> Result<Outcome> {
    let started = Instant::now();
    let outcome = process(
        ctx,
        "release-build",
        "cargo",
        &["build", "--workspace", "--release"],
    )?;
    let seconds = started.elapsed().as_secs_f64();
    if matches!(outcome, Outcome::Ok(_)) {
        let dir = ctx.artifacts.join("release-build");
        fs::create_dir_all(&dir)?;
        fs::write(
            dir.join("timing.json"),
            format!(
                "{{\n  \"hardware\": \"{}\",\n  \"releaseBuildSeconds\": {seconds:.1}\n}}\n",
                ctx.hardware
            ),
        )?;
        let ceiling = ledger::compile_time_ceiling(&ctx.root, &ctx.hardware, "releaseBuildSeconds");
        let evidence = display_relative(&ctx.root, &dir);
        return match ceiling {
            Some(ceiling) if seconds > ceiling => Ok(Outcome::Failed(format!(
                "cargo build --workspace --release took {seconds:.1}s against the {ceiling:.0}s ceiling in {} — evidence: {evidence}",
                ledger::COMPILE_TIME
            ))),
            Some(ceiling) => Ok(Outcome::Ok(format!(
                "cargo build --workspace --release in {seconds:.1}s of {ceiling:.0}s — evidence: {evidence}"
            ))),
            None => Ok(Outcome::Ok(format!(
                "cargo build --workspace --release in {seconds:.1}s; {} states no `releaseBuildSeconds` ceiling for {}, so nothing was enforced — evidence: {evidence}",
                ledger::COMPILE_TIME,
                ctx.hardware
            ))),
        };
    }
    Ok(outcome)
}

/// The v1 tree's TypeScript, through the repo's own script.
///
/// There is none today, and this step says so rather than running v0's static
/// gate: #1020 rules v0's gates off pull requests from wave 1, so re-running
/// them here under a different name would be the same CI bill with the ruling
/// pasted over it. The moment a `.ts` file appears anywhere in the v1 tree, the
/// step runs `bun run check:push:static` for real.
fn run_ts_static(ctx: &Ctx) -> Result<Outcome> {
    const V1_DIRS: [&str; 5] = ["crates", "contracts", "mobile", "desktop", "extension"];
    const EXTENSIONS: [&str; 4] = ["ts", "tsx", "mts", "cts"];
    let mut found = Vec::new();
    for dir in V1_DIRS {
        let path = ctx.root.join(dir);
        if !path.is_dir() {
            continue;
        }
        for extension in EXTENSIONS {
            found.extend(rules::source_files(&path, extension));
        }
    }
    if found.is_empty() {
        return Ok(Outcome::Skipped(
            "no TypeScript in the v1 tree yet (crates/, contracts/, mobile/, desktop/, extension/) — `bun run check:push:static` runs here the moment there is. v0's own static gate runs on main pushes and nightly, not on pull requests (#1020)"
                .to_owned(),
        ));
    }
    process(ctx, "ts-static", "bun", &["run", "check:push:static"])
}

/// The v0 oracle: the pinned v0 tree's own tests over the `contracts/` files.
///
/// One suite today — the golden vault, which lane A keeps green against
/// `contracts/`. This is the whole of what v0's CI still owes a v1 commit
/// (#1020, *Two trees, one CI bill*), and it runs nightly, not per PR.
///
/// The suite imports its workspace packages by their PUBLISHED entry points
/// (`@centraid/core/blob`), so it needs their `dist/` on disk — the same reason
/// `ci.yml`'s `verify` job builds before it runs vitest. The build is turbo-
/// cached and filtered to the suite's closure, so a warm tree pays ~0.5 s for
/// it; running the suite without it fails with a module-resolution error that
/// looks like a product bug and is not one.
fn run_v0_oracle(ctx: &Ctx) -> Result<Outcome> {
    const SUITE: &str = "packages/vault/src/golden-vault.test.ts";
    if !ctx.root.join(SUITE).is_file() {
        return Ok(Outcome::Failed(format!(
            "{SUITE} is gone — the v0 oracle suite is the only thing keeping `contracts/` honest while both trees exist. If v0 was retired, this step retires with it (wave 6), not before"
        )));
    }
    let built = process(
        ctx,
        "v0-oracle-build",
        "node",
        &[
            "scripts/ci/turbo.mjs",
            "run",
            "build",
            "--filter=@centraid/vault...",
        ],
    )?;
    if let Outcome::Failed(detail) = built {
        return Ok(Outcome::Failed(format!(
            "the oracle suite's package closure would not build: {detail}"
        )));
    }
    process(ctx, "v0-oracle", "bunx", &["vitest", "run", SUITE])
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn indent(block: &str) -> String {
    block
        .lines()
        .map(|entry| format!("        {entry}\n"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(profile: Profile) -> Vec<&'static str> {
        steps(profile).into_iter().map(|entry| entry.name).collect()
    }

    #[test]
    fn each_profile_is_a_superset_of_the_one_before() {
        let local = names(Profile::Local);
        let pr = names(Profile::Pr);
        let nightly = names(Profile::Nightly);
        let release = names(Profile::Release);
        assert_eq!(&pr[..local.len()], &local[..]);
        assert_eq!(&nightly[..pr.len()], &pr[..]);
        assert_eq!(&release[..nightly.len()], &nightly[..]);
    }

    /// The repo-wide CI policy and security lanes are not v0's gates, so taking
    /// ci.yml off `pull_request` must not take them off pull requests. They are
    /// steps of the gate that replaced it, and this test is what says so. Two of
    /// them are red on inherited tree state (D-1020-B1) and that is not a reason
    /// for them to be absent — a gate that stops reporting because its target is
    /// red today is a weakening.
    #[test]
    fn pr_carries_the_ci_policy_and_security_steps() {
        let pr = names(Profile::Pr);
        for required in ["ci-policy", "secrets", "osv", "buf"] {
            assert!(
                pr.contains(&required),
                "`{required}` missing from pr: {pr:?}"
            );
        }
    }

    #[test]
    fn local_carries_the_five_cheap_steps() {
        assert_eq!(
            names(Profile::Local),
            ["fmt", "clippy", "test", "rules", "ledgers"]
        );
    }

    #[test]
    fn release_adds_exactly_the_restore_drill_and_the_vps_smoke() {
        let nightly = names(Profile::Nightly);
        let release = names(Profile::Release);
        assert_eq!(&release[nightly.len()..], ["restore-drill", "vps-smoke"]);
    }

    /// The placeholders must FAIL, not skip. A profile that can pass without
    /// the restore drill would report "release is green" for a release that was
    /// never proven restorable.
    #[test]
    fn the_placeholders_fail_rather_than_skip() {
        let ctx = Ctx {
            root: PathBuf::from("."),
            hardware: DEFAULT_HARDWARE.to_owned(),
            ci: false,
            artifacts: PathBuf::from("target/xtask/release"),
        };
        for entry in steps(Profile::Release) {
            // `restore-drill` is real as of wave 2 lane R, so it is no longer a
            // placeholder and is not in this test's subject. `vps-smoke` still
            // is, and the rule it proves is unchanged: a placeholder FAILS.
            if entry.name != "vps-smoke" {
                continue;
            }
            let outcome = (entry.run)(&ctx).expect("placeholder runs");
            match outcome {
                Outcome::Failed(detail) => {
                    assert!(
                        detail.starts_with("not implemented: lands in wave "),
                        "{detail}"
                    );
                }
                _ => panic!("{} must fail, not pass or skip", entry.name),
            }
        }
    }

    /// The version window is the last three MINORS, one tag each (the highest
    /// patch), newest first — and a prerelease is not a released tag. The
    /// arithmetic is pinned with a table because #1020's promise is to seats
    /// running a tag, and a window that silently picked three patches of one
    /// minor would check one release three times.
    #[test]
    fn the_window_is_three_minors_at_their_highest_patch() {
        let root = crate::testing::fixture_dir("buf-window");
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "--quiet"]);
        git(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "base",
        ]);
        for tag in [
            "v1.0.0",
            "v1.1.0",
            "v1.1.4",
            "v1.2.0",
            "v1.3.0",
            "v1.3.1",
            "v2.0.0-rc.1",
            "vnope",
        ] {
            git(&["tag", tag]);
        }
        assert_eq!(window_tags(&root), ["v1.3.1", "v1.2.0", "v1.1.4"]);
    }

    #[test]
    fn the_buf_step_skips_loudly_before_the_schema_lands() {
        let root = crate::testing::fixture_dir("buf-absent");
        let ctx = Ctx {
            root: root.clone(),
            hardware: DEFAULT_HARDWARE.to_owned(),
            ci: false,
            artifacts: root.join("target"),
        };
        match run_buf(&ctx).expect("the step runs") {
            Outcome::Skipped(detail) => assert!(detail.contains("no buf.yaml"), "{detail}"),
            _ => panic!("without buf.yaml the step must skip loudly"),
        }
    }

    /// `mobile-jvm` is a ledger placeholder: no steps, and a refusal rather
    /// than a vacuous pass. A profile with an empty step list that scored itself
    /// green would report "the Kotlin suites passed" before one exists.
    #[test]
    fn the_mobile_jvm_profile_has_no_steps_and_refuses_to_run() {
        assert!(steps(Profile::MobileJvm).is_empty());
        let root = crate::testing::fixture_dir("mobile-jvm");
        assert!(
            !run(Profile::MobileJvm, &root, false).expect("the refusal is not an error"),
            "a refusal must not be a pass"
        );
    }

    fn build_tree(root: &Path, members: &[&str], linked: &[&str]) {
        for member in members {
            let dir = root.join("crates").join(member);
            fs::create_dir_all(&dir).expect("create the member dir");
            fs::write(
                dir.join("Cargo.toml"),
                format!("[package]\nname = \"centraid-{member}\"\nversion = \"0.1.0\"\n\n[dependencies]\nname = \"not-a-package-name\"\n"),
            )
            .expect("write the manifest");
        }
        let deps = root.join("target/debug/deps");
        fs::create_dir_all(&deps).expect("create deps");
        for name in linked {
            fs::write(deps.join(name), "").expect("write an artifact");
        }
    }

    /// The detection is over LINKED artifacts, and this is the case that says
    /// why: a tree that has only been `cargo check`ed carries `.rmeta` for every
    /// member and still has to compile and link every test binary, so it is
    /// cold — otherwise a 5 s `cargo check` would buy a warm 120 s budget.
    #[test]
    fn an_rmeta_only_tree_is_cold_and_a_linked_tree_is_warm() {
        let root = crate::testing::fixture_dir("tree-rmeta");
        build_tree(
            &root,
            &["net", "seat"],
            &["libcentraid_net-1a.rmeta", "libcentraid_seat-2b.rmeta"],
        );
        let (state, why) = tree_state(&root, false);
        assert_eq!(state, Tree::Cold, "{why}");
        assert!(why.contains("does not count"), "{why}");

        let warm = crate::testing::fixture_dir("tree-linked");
        build_tree(
            &warm,
            &["net", "seat"],
            &[
                "libcentraid_net-1a.rlib",
                "libcentraid_net-1a.rmeta",
                "centraid_seat-2b",
            ],
        );
        let (state, why) = tree_state(&warm, false);
        assert_eq!(state, Tree::Warm, "{why}");
        assert!(why.contains("all 2 workspace member(s)"), "{why}");
    }

    /// One member built and one not is cold. A partial tree passing as warm is
    /// how a budget stops covering the crate that was just added.
    #[test]
    fn a_partially_built_tree_is_cold_and_names_the_member() {
        let root = crate::testing::fixture_dir("tree-partial");
        build_tree(&root, &["net", "seat"], &["libcentraid_net-1a.rlib"]);
        let (state, why) = tree_state(&root, false);
        assert_eq!(state, Tree::Cold, "{why}");
        assert!(why.contains("centraid-seat"), "{why}");
        let (forced, why) = tree_state(&root, true);
        assert_eq!(forced, Tree::Cold);
        assert!(why.contains("`--cold` was passed"), "{why}");
    }

    fn scoring_ctx(root: &Path) -> Ctx {
        Ctx {
            root: root.to_path_buf(),
            hardware: "h".to_owned(),
            ci: false,
            artifacts: root.join("target/xtask/local"),
        }
    }

    fn with_cold_ceiling(name: &str, ceiling: Option<f64>) -> PathBuf {
        let root = crate::testing::fixture_dir(name);
        fs::create_dir_all(root.join("contracts/ledgers")).expect("create the ledger dir");
        let body = match ceiling {
            Some(seconds) => format!(r#"{{"{COLD_LOCAL_KEY}":{{"budgetSeconds":{seconds}}}}}"#),
            None => "{}".to_owned(),
        };
        fs::write(
            root.join(ledger::COMPILE_TIME),
            format!(r#"{{"measurements":{{"h":{body}}}}}"#),
        )
        .expect("seed the ledger");
        root
    }

    /// The two scoring branches, and the one thing that must not be true of
    /// either: a cold tree cannot pass the WARM budget by being cold, and it
    /// cannot pass unscored (D-1020-B2-1).
    #[test]
    fn a_cold_local_run_is_charged_to_its_own_ceiling_and_never_goes_unscored() {
        let root = with_cold_ceiling("score-cold", Some(400.0));
        let ctx = scoring_ctx(&root);
        // Warm: the gate budget, as before.
        assert!(score(Profile::Local, Tree::Warm, 90.0, Some(120.0), &ctx));
        assert!(!score(Profile::Local, Tree::Warm, 130.0, Some(120.0), &ctx));
        // Cold: the compile-time ceiling, not the 120 s budget — 300 s is over
        // the warm budget and under the cold ceiling, and holds.
        assert!(score(Profile::Local, Tree::Cold, 300.0, Some(120.0), &ctx));
        assert!(
            !score(Profile::Local, Tree::Cold, 401.0, Some(120.0), &ctx),
            "over its own cold ceiling is still a failure"
        );

        let unstated = with_cold_ceiling("score-cold-unstated", None);
        assert!(
            !score(
                Profile::Local,
                Tree::Cold,
                1.0,
                Some(120.0),
                &scoring_ctx(&unstated)
            ),
            "a cold run with no stated ceiling must fail, not pass unscored"
        );
    }

    /// Every profile but `local` runs in CI on a runner that has never seen the
    /// workspace, so its budget has to hold on a cold tree: the state is
    /// reported and the number scored is still `budgetSeconds`.
    #[test]
    fn pr_is_scored_against_its_budget_on_a_cold_tree() {
        let root = with_cold_ceiling("score-pr", Some(400.0));
        let ctx = scoring_ctx(&root);
        assert!(score(Profile::Pr, Tree::Cold, 380.0, Some(900.0), &ctx));
        assert!(
            !score(Profile::Pr, Tree::Cold, 901.0, Some(900.0), &ctx),
            "the cold ceiling belongs to `local` alone"
        );
        assert!(
            score(Profile::Nightly, Tree::Cold, 9_999.0, None, &ctx),
            "unbounded by ruling"
        );
    }

    /// The secrets step drops a finding only when git says the file is neither
    /// tracked nor part of the repository (D-1020-B2-5). The two halves that
    /// matter are pinned here: iroh's `.rmeta` under `target/` goes, and a
    /// tracked file goes nowhere — including a tracked file that matches an
    /// ignore pattern, which is the case a naive `.gitignore` filter would lose.
    #[test]
    fn only_untracked_ignored_build_output_is_dropped_from_a_secrets_report() {
        let root = crate::testing::fixture_dir("secrets-membership");
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "--quiet"]);
        fs::write(root.join(".gitignore"), "target\nkept.log\n").expect("write .gitignore");
        fs::create_dir_all(root.join("target/debug/deps")).expect("create target");
        fs::write(root.join("target/debug/deps/libpem.rmeta"), "-----BEGIN").expect("write rmeta");
        fs::write(root.join("kept.log"), "tracked though ignored").expect("write kept.log");
        fs::write(root.join("src.rs"), "fn main() {}").expect("write src.rs");
        git(&["add", "--force", ".gitignore", "kept.log", "src.rs"]);
        git(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "--quiet",
            "-m",
            "base",
        ]);
        let files = [
            "target/debug/deps/libpem.rmeta".to_owned(),
            "kept.log".to_owned(),
            "src.rs".to_owned(),
        ];
        let (in_repo, dropped) = split_by_repository_membership(&root, &files);
        assert_eq!(dropped, ["target/debug/deps/libpem.rmeta"]);
        assert_eq!(in_repo, ["kept.log", "src.rs"]);
    }

    /// A report gitleaks never wrote is zero findings; a report it wrote is read
    /// by its `File` field. Anything else would make the step's verdict depend
    /// on a parse that silently returned nothing.
    #[test]
    fn a_gitleaks_report_is_read_by_its_file_field() {
        let root = crate::testing::fixture_dir("secrets-report");
        assert!(
            report_files(&root.join("absent.json"))
                .expect("an absent report is not an error")
                .is_empty()
        );
        let path = root.join("report.json");
        fs::write(&path, r#"[{"File":"a/b.md","RuleID":"generic-api-key"}]"#).expect("write");
        assert_eq!(report_files(&path).expect("parse"), ["a/b.md"]);
    }

    #[test]
    fn the_step_line_states_the_verdict_first() {
        let elapsed = Duration::from_millis(1500);
        assert!(line("fmt", elapsed, &Outcome::Ok("cargo fmt".to_owned())).starts_with("ok "));
        assert!(line("deny", elapsed, &Outcome::Skipped("x".to_owned())).starts_with("SKIP "));
        assert!(line("test", elapsed, &Outcome::Failed("x".to_owned())).starts_with("FAIL "));
    }
}
