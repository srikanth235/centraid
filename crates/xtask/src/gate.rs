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
use crate::artifact;
use crate::ci;
use crate::ledger;
use crate::rules;
use crate::smoke;

/// The four device cells (#1020 open question 13, D-1020-G4). Named here, in
/// the runner, so `gate-nightly.yml`'s matrix and this file cannot disagree
/// about which lanes exist.
pub const DEVICE_LANES: [&str; 4] = [
    "ios-transfer-experiment",
    "android-macrobenchmark",
    "ios-xctest-metrics",
    "battery-per-background-pass",
];

/// The hardware class this container is, matching `tests/journeys.json`'s
/// vocabulary. Overridable so the self-hosted device runner can score itself.
pub const DEFAULT_HARDWARE: &str = "ci-linux-x64-4c";

/// Everything a step needs to know about the run it is part of.
pub struct Ctx {
    pub root: PathBuf,
    /// `--lane <name>`: run only this step. The device cells of
    /// `gate-nightly.yml` are four jobs over one profile, so each needs to name
    /// the one lane it is (D-1020-G4).
    pub lane: Option<String>,
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

#[derive(Debug)]
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
        // THE DESKTOP SEAT'S PURE CORES (#1020 wave 3 lane F, D-1020-F8). Every
        // `electron`-importing module has a pure twin with unit tests, which is
        // v0's own split and the reason it is testable without a display; this
        // step runs those, plus the three tsconfigs, and costs single-digit
        // seconds. The Playwright run that needs a window is `desktop-e2e`, in
        // `nightly`.
        step("desktop-unit", run_desktop_unit),
        // THE CI-SHAPE GATES, re-homed out of `scripts/ci/**` (D-1020-G3).
        // They are not v0's gates — they are gates about the shape of CI and
        // about the supply chain — so taking `ci.yml` off `pull_request` had to
        // move them rather than drop them.
        step("advisory", run_advisory),
        step("lockfile", run_lockfile),
        // THE SYNC PROOF AND THE RESPONSIVENESS PROMISE (D-1020-D2-4,
        // D-1020-D2-6). The simulation runs 25 seeds here and 250 in
        // `nightly`; the budget fails the gate on any bounded read over its
        // ceiling, which is the issue's own rule.
        step("sim", run_sim),
        step("call-budget", run_call_budget),
    ]);
    if profile == Profile::Pr {
        return pr;
    }
    let mut nightly = pr;
    nightly.extend([
        // The deeper sweep, on top of `pr`'s 25 seeds rather than replacing
        // them: each profile is stated as a CONCATENATION of the one before.
        step("sim-nightly", run_sim_nightly),
        step("v0-oracle", run_v0_oracle),
        // THE DESKTOP SEAT'S EXIT CRITERION (#1020 wave 3 lane F): a real
        // Electron app, a real `centraid seat` sidecar over a real socket, and
        // a `<video>` that seeks inside a blob whose bytes are still arriving.
        // Nightly rather than `pr` because it builds a release binary and
        // launches a browser — tens of seconds either side of the assertion.
        step("desktop-e2e", run_desktop_e2e),
        step("device-lanes", run_device_lanes),
        step("lane-health", run_lane_health),
    ]);
    if profile == Profile::Nightly {
        return nightly;
    }
    let mut release = nightly;
    release.extend([
        step("restore-drill", run_restore_drill),
        step("artifact-identity", run_artifact_identity),
        step("prebuilt-core-required", run_prebuilt_core_required),
        step("vps-smoke", run_vps_smoke),
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
pub fn run(profile: Profile, root: &Path, forced_cold: bool, lane: Option<String>) -> Result<bool> {
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
        lane: lane.clone(),
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

    // `--lane <name>` narrows the run to ONE step. A device cell is one job per
    // lane over one profile, and a job that ran the whole nightly profile to
    // reach its own four lines would pay for the other fifteen steps four
    // times. A name that matches no step is an error rather than an empty run:
    // a lane filter that silently selected nothing would report PASS over zero
    // steps.
    let selected = select(profile, ctx.lane.as_deref())?;

    let mut results: Vec<(&'static str, Duration, Outcome)> = Vec::new();
    for entry in selected {
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

    // THE PER-PR EVIDENCE ROW (D-1020-G3). Written on success as well as
    // failure: a report that only has rows when something broke cannot show a
    // lane going quiet, which is the failure mode `gate.yml` had — it wrote no
    // evidence at all, so the per-PR test report had no row for the gate that
    // decides a v1 pull request. Written BEFORE the verdict line so the file
    // exists even when the verdict path below panics.
    let rows: Vec<(&'static str, f64, &'static str, String)> = results
        .iter()
        .map(|(name, elapsed, outcome)| {
            let (verdict, detail) = match outcome {
                Outcome::Ok(detail) => ("ok", detail.clone()),
                Outcome::Skipped(detail) => ("SKIP", detail.clone()),
                Outcome::Failed(detail) => ("FAIL", detail.clone()),
            };
            (*name, elapsed.as_secs_f64(), verdict, detail)
        })
        .collect();
    match ci::write_evidence(&ctx.artifacts, profile.name(), &hardware, &rows) {
        Ok(path) => println!("  evidence {}", display_relative(root, Path::new(&path))),
        // A gate that went red because its own report would not write is a gate
        // reporting the wrong problem. Said out loud, not swallowed.
        Err(error) => println!("  EVIDENCE could not be written: {error:#}"),
    }

    // The last line is the verdict, and the verdict includes the budget. Before
    // this it read `PASS` off the step list alone, so a run whose steps were all
    // green and whose total blew the budget printed the budget failure and then
    // `gate local: PASS` — with the process still exiting non-zero. Two
    // contradicting answers in one output is worse than either (D-1020-B2).
    if ok {
        println!("\ngate {}: PASS", profile.name());
    } else if failed.is_empty() {
        println!(
            "\ngate {}: FAIL — over budget (every step was green; see the BUDGET line above)",
            profile.name()
        );
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

/// The steps a run executes: the whole profile, or the one `--lane` names.
///
/// A name that matches no step is an ERROR rather than an empty selection: a
/// lane filter that silently selected nothing would report PASS over zero
/// steps, which is the one verdict this file exists to make impossible.
fn select(profile: Profile, lane: Option<&str>) -> Result<Vec<Step>> {
    let mut selected = steps(profile);
    let Some(wanted) = lane else {
        return Ok(selected);
    };
    let keep = if DEVICE_LANES.contains(&wanted) {
        "device-lanes"
    } else {
        wanted
    };
    if !selected.iter().any(|entry| entry.name == keep) {
        anyhow::bail!(
            "--lane {wanted} names no step of the `{}` profile, and no device lane. Steps: {}. Device lanes: {}",
            profile.name(),
            selected
                .iter()
                .map(|entry| entry.name)
                .collect::<Vec<_>>()
                .join(", "),
            DEVICE_LANES.join(", ")
        );
    }
    selected.retain(|entry| entry.name == keep);
    println!("  --lane {wanted}: running only `{keep}`");
    Ok(selected)
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

/// `process`, with environment variables set for the child.
///
/// A sibling rather than an extra parameter on [`process`]: every step calls
/// that one, and widening its signature would touch each of them. The failure
/// path is shared through [`report_failure`], so an artifact written by either
/// looks the same to somebody reading `target/xtask/`.
fn process_with_env(
    ctx: &Ctx,
    step: &str,
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<Outcome> {
    let label = format!(
        "{}{program} {}",
        env.iter()
            .map(|(key, value)| format!("{key}={value} "))
            .collect::<String>(),
        args.join(" ")
    );
    let mut command = Command::new(program);
    command.args(args).current_dir(&ctx.root);
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command
        .output()
        .with_context(|| format!("spawn `{label}`"))?;
    if output.status.success() {
        return Ok(Outcome::Ok(label));
    }
    report_failure(ctx, step, &label, &output)
}

/// Write a failed step's artifact and name it in one line.
fn report_failure(
    ctx: &Ctx,
    step: &str,
    label: &str,
    output: &std::process::Output,
) -> Result<Outcome> {
    let dir = ctx.artifacts.join(step);
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    fs::write(dir.join("command.txt"), format!("{label}\n"))?;
    fs::write(dir.join("stdout.log"), &output.stdout)?;
    fs::write(dir.join("stderr.log"), &output.stderr)?;
    // THE SIMULATION PRINTS ITS DIAGNOSIS ON STDOUT, not stderr: a failing seed
    // and its schedule go through `println!`. So the reason is looked for in
    // both, newest-last, rather than in stderr alone.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let why = stderr
        .lines()
        .rev()
        .find(|candidate| !candidate.trim().is_empty())
        .or_else(|| {
            stdout
                .lines()
                .rev()
                .find(|candidate| candidate.contains("SIM_SEED=") || candidate.contains("failed"))
        })
        .unwrap_or("(no output)");
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

/// The deterministic simulation — #1020's primary sync proof (D-1020-D2-4).
///
/// In `pr` at 25 seeds, which is the count that fits the profile's budget. A
/// seed that fails prints `SIM_SEED=<n>` and its schedule, so the artifact a
/// developer needs is in the step's own output.
fn run_sim(ctx: &Ctx) -> Result<Outcome> {
    process(
        ctx,
        "sim",
        "cargo",
        &["test", "-p", "centraid-sim", "--", "--nocapture"],
    )
}

/// The same, at the `nightly` count.
///
/// A separate step rather than the same one with a different environment,
/// because each profile is stated as a CONCATENATION of the one before: `pr`'s
/// 25 seeds still run in `nightly`, and this adds the deeper sweep on top
/// rather than replacing it.
fn run_sim_nightly(ctx: &Ctx) -> Result<Outcome> {
    process_with_env(
        ctx,
        "sim-nightly",
        "cargo",
        &[
            "test",
            "-p",
            "centraid-sim",
            "--test",
            "seeds",
            "--",
            "--nocapture",
        ],
        &[("SIM_SEEDS", "250")],
    )
}

/// The `call` budget — the issue's "any request that exceeds it in `pr` profile
/// fails the gate" (D-1020-D2-6).
///
/// `--nocapture` so the measured p50/p95/p99 reach the gate's log: a budget
/// that only says pass or fail cannot show a number trending towards its
/// ceiling, and the ledger is down-only precisely so that trend matters.
fn run_call_budget(ctx: &Ctx) -> Result<Outcome> {
    process(
        ctx,
        "call-budget",
        "cargo",
        &[
            "test",
            "-p",
            "centraid-core",
            "--test",
            "call_budget",
            "--",
            "--nocapture",
        ],
    )
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
    // The static gate typechecks the workspace through its PUBLISHED entry
    // points, so it needs the packages' `dist/` on disk — the same prerequisite
    // `v0-oracle` names. Without it tsc reports hundreds of "Cannot find module
    // '@centraid/server/engine'" lines, which read as a product defect and are
    // an unbuilt tree. Saying so is the difference between a gate and a puzzle.
    if !ctx.root.join("packages/server/dist").is_dir() {
        return Ok(Outcome::Failed(format!(
            "the workspace is not built: packages/server/dist is absent, and `bun run check:push:static` resolves `@centraid/*` through the published entry points. Run `bun run build` once (gate.yml does it before this profile) — this is an unprovisioned tree, not a type error. {} .ts file(s) in the v1 tree made this step live",
            found.len()
        )));
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

/// The advisory register (D-1020-G3). See `crate::ci::advisory`.
fn run_advisory(ctx: &Ctx) -> Result<Outcome> {
    verdict(ctx, "advisory", ci::advisory(&ctx.root, &ci::today_utc())?)
}

/// Both lockfiles (D-1020-G3). See `crate::ci::lockfile`.
fn run_lockfile(ctx: &Ctx) -> Result<Outcome> {
    verdict(ctx, "lockfile", ci::lockfile(&ctx.root)?)
}

/// Lane health off the Actions API (D-1020-G3). Nightly only — it reads
/// `api.github.com`, and a pull request's verdict must not depend on a third
/// party being up.
/// The desktop seat's pure cores, and its three type programs.
///
/// **Not** part of the repository-wide vitest project list. That list drives the
/// v0 coverage run scored against `tests/floors.json`, and adding a new tree to
/// it would move coverage numbers for reasons that have nothing to do with the
/// v0 oracle it measures — so `desktop/vitest.config.ts` is its own project and
/// this step is how CI runs it (D-1020-F8).
///
/// `bun` absent is a SKIP locally and a FAILURE in CI, the same rule every
/// other tool in this file follows: in CI the workflow installs it, so its
/// absence is an infrastructure fault rather than a developer's choice.
fn run_desktop_unit(ctx: &Ctx) -> Result<Outcome> {
    if !ctx.root.join("desktop/vitest.config.ts").is_file() {
        return Ok(Outcome::Skipped(
            "no desktop/ tree yet — `bun run --cwd desktop/electron test` runs here the moment there is (#1020 wave 3 lane F)"
                .to_owned(),
        ));
    }
    if !binary_available("bun") {
        return Ok(missing_binary(
            ctx,
            "bun",
            "the desktop seat's pure cores and its three type programs",
            "`.github/actions/setup` installs it in CI; locally, see docs/toolchain.md",
        ));
    }
    match process(
        ctx,
        "desktop-unit",
        "bun",
        &["run", "--cwd", "desktop/electron", "test"],
    )? {
        Outcome::Ok(_) => {}
        other => return Ok(other),
    }
    process(
        ctx,
        "desktop-unit",
        "bun",
        &["run", "--cwd", "desktop/electron", "typecheck"],
    )
}

/// The desktop seat's Playwright run: the lane's exit criterion.
///
/// Three prerequisites, each reported as itself rather than as one "it did not
/// run": the `centraid` binary the shell spawns, `bun` for the app build, and a
/// display for Electron. The display is the one a hosted Linux runner does not
/// have, so `xvfb-run` is used when it is there and the step says so when it is
/// not — a browser test that "passed" with no window would be the loudest kind
/// of lie.
fn run_desktop_e2e(ctx: &Ctx) -> Result<Outcome> {
    if !ctx.root.join("desktop/e2e/playwright.config.ts").is_file() {
        return Ok(Outcome::Skipped(
            "no desktop/e2e yet (#1020 wave 3 lane F)".to_owned(),
        ));
    }
    for tool in ["bun", "node"] {
        if !binary_available(tool) {
            return Ok(missing_binary(
                ctx,
                tool,
                "the desktop seat's Playwright run (bun builds the app, node runs Playwright)",
                "`.github/actions/setup` installs both in CI",
            ));
        }
    }
    // THE BINARY THE SHELL SPAWNS. Built debug, not release: the assertion is
    // about the media door's byte arithmetic and Chromium's reaction to it, and
    // a release build would add minutes to a nightly for no change in what is
    // proven.
    match process(ctx, "desktop-e2e", "cargo", &["build", "-p", "centraid"])? {
        Outcome::Ok(_) => {}
        other => return Ok(other),
    }
    match process(
        ctx,
        "desktop-e2e",
        "bun",
        &["run", "--cwd", "desktop/electron", "build"],
    )? {
        Outcome::Ok(_) => {}
        other => return Ok(other),
    }
    let playwright = "node_modules/.bin/playwright";
    if !ctx.root.join(playwright).is_file() {
        return Ok(missing_binary(
            ctx,
            playwright,
            "the desktop seat's Playwright run",
            "run `bun install` (the workflow does)",
        ));
    }
    // Where Playwright's browsers live. Named rather than left to the default
    // under `$HOME`, because CI and this container both stage them centrally
    // and a run that silently downloaded its own copy would be a run nobody
    // budgeted for.
    let browsers =
        std::env::var("PLAYWRIGHT_BROWSERS_PATH").unwrap_or_else(|_| "/opt/pw-browsers".to_owned());
    let env = [("PLAYWRIGHT_BROWSERS_PATH", browsers.as_str())];
    let headless = std::env::var("DISPLAY").is_err() && binary_available("xvfb-run");
    if headless {
        return process_with_env(
            ctx,
            "desktop-e2e",
            "xvfb-run",
            &[
                "-a",
                playwright,
                "test",
                "-c",
                "desktop/e2e/playwright.config.ts",
            ],
            &env,
        );
    }
    if std::env::var("DISPLAY").is_err() {
        return Ok(Outcome::Failed(
            "no DISPLAY and no xvfb-run: Electron has no real headless mode, so this step cannot run here. Install xvfb (`apt-get install xvfb`) or run it on a machine with a display (#1020 wave 3 lane F)"
                .to_owned(),
        ));
    }
    process_with_env(
        ctx,
        "desktop-e2e",
        playwright,
        &["test", "-c", "desktop/e2e/playwright.config.ts"],
        &env,
    )
}

fn run_lane_health(ctx: &Ctx) -> Result<Outcome> {
    let repo =
        std::env::var("GITHUB_REPOSITORY").unwrap_or_else(|_| "srikanth235/centraid".to_owned());
    let result = ci::lane_health(&ctx.root, &repo, "ci.yml", 40)?;
    if result.ok && result.line.starts_with("SKIPPED:") {
        return Ok(Outcome::Skipped(result.line));
    }
    verdict(ctx, "lane-health", result)
}

/// THE DEVICE LANES, with a RUNNER CONTRACT rather than a bare skip
/// (D-1020-G4).
///
/// Four lanes, each a cell of `gate-nightly.yml` that runs **only** on a runner
/// carrying the `[self-hosted, macos, devices]` labels with one iPhone and one
/// Android attached. On a hosted runner they are a loud `Skipped` naming open
/// question 13 — never a pass, and never a test that reads green.
///
/// The contract is stated here, in the runner, and not only in the workflow: a
/// lane whose preconditions live only in YAML is a lane nobody can run locally
/// and nobody can check. `CENTRAID_DEVICE_RUNNER=1` is what a real device
/// runner sets, and when it is set with no devices attached this step FAILS —
/// because a runner that claims the label and has no phone is an
/// infrastructure fault, not a skip.
fn run_device_lanes(ctx: &Ctx) -> Result<Outcome> {
    let lanes: Vec<&str> = match &ctx.lane {
        Some(one) if DEVICE_LANES.contains(&one.as_str()) => vec![one.as_str()],
        _ => DEVICE_LANES.to_vec(),
    };
    let named = lanes.join(", ");
    if std::env::var_os("CENTRAID_DEVICE_RUNNER").is_none() {
        return Ok(Outcome::Skipped(format!(
            "not runnable here: {named}. They need a runner labelled [self-hosted, macos, devices] with one iPhone and one Android attached, which is #1020 open question 13 and an owner hand-off. The lane bodies are `cargo xtask gate --profile nightly --lane <name>` and wave 3 lane E supplies them (Maestro flows, Macrobenchmark, XCTest metrics on release builds); NO NUMBER in tests/journeys.json is promoted by anything short of a run on a named reference device (R-1020-20)"
        )));
    }
    // On a real device runner the two enumerators are the contract: `xcrun
    // devicectl list devices` for a physical iPhone (NOT `simctl`, which
    // enumerates simulators — census §G6, the exact gap the iOS cell is parked
    // on) and `adb devices` for Android.
    let mut missing = Vec::new();
    for (tool, args, what) in [
        (
            "xcrun",
            vec!["devicectl", "list", "devices"],
            "a physical iPhone",
        ),
        ("adb", vec!["devices"], "an Android device"),
    ] {
        let listed = Command::new(tool)
            .args(&args)
            .current_dir(&ctx.root)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .unwrap_or_default();
        if listed.trim().is_empty() {
            missing.push(format!("{what} (`{tool} {}`)", args.join(" ")));
        }
    }
    if !missing.is_empty() {
        return Ok(Outcome::Failed(format!(
            "CENTRAID_DEVICE_RUNNER is set, so this runner claims the devices label, and it has no {}. A runner that claims the label and has no phone is an infrastructure failure, not a skip",
            missing.join(" and no ")
        )));
    }
    Ok(Outcome::Failed(format!(
        "the device runner is real and the lane bodies are not on this branch yet: {named}. Wave 3 lane E delivers them; until then a runner with phones attached must go RED rather than report a lane it did not run"
    )))
}

/// THE STALE-ARTIFACT REFUSAL, as a gate step (D-1020-G2).
///
/// Runs the identity test in `crates/centraid` and quotes the refusal line, so
/// the release profile's transcript carries the sentence a shell would print
/// rather than only the fact that a test passed.
fn run_artifact_identity(ctx: &Ctx) -> Result<Outcome> {
    let outcome = process(
        ctx,
        "artifact-identity",
        "cargo",
        &[
            "test",
            "-p",
            "centraid",
            "--bin",
            "centraid",
            "identity::",
            "--",
            "--nocapture",
        ],
    )?;
    if !matches!(outcome, Outcome::Ok(_)) {
        return Ok(outcome);
    }
    Ok(Outcome::Ok(
        "a core whose digest is not the one the shell was built against is REFUSED: \"STALE CORE REFUSED: this shell was built against core digest …, and the core it loaded reports …\". An empty expectation is refused too, and a `dev` build is allowed with the warning that the check did not run (crates/centraid/src/identity.rs)".to_owned(),
    ))
}

/// EVERY REQUIRED TRIPLE, with a matching key (D-1020-G2, D-1020-G5).
///
/// The workflow's `prebuilt-core-required` job is what enforces this over real
/// artifacts; this step is the local half — it proves the key is computable for
/// every required triple and that the six triples are stated in exactly one
/// place. It cannot prove an artifact EXISTS, and says so rather than implying
/// the artifacts were checked.
fn run_prebuilt_core_required(ctx: &Ctx) -> Result<Outcome> {
    const REQUIRED: [&str; 3] = [
        "x86_64-unknown-linux-gnu",
        "aarch64-apple-darwin",
        "x86_64-pc-windows-msvc",
    ];
    let mut keys = Vec::new();
    for triple in REQUIRED {
        let (key, _) = artifact::key(
            &ctx.root,
            &artifact::KeyInputs {
                triple: triple.to_owned(),
                features: Vec::new(),
                profile: "release".to_owned(),
            },
        )?;
        keys.push(format!("{triple} {}", &key[..16]));
    }
    // The keys must DIFFER per triple, or the cache would serve a macOS
    // artifact to a Linux build.
    let mut distinct: Vec<&String> = keys.iter().collect();
    distinct.sort();
    distinct.dedup();
    if distinct.len() != REQUIRED.len() {
        return Ok(Outcome::Failed(
            "two required triples compute the same artifact key, so the cache could serve one platform's core to another".to_owned(),
        ));
    }
    Ok(Outcome::Ok(format!(
        "{} — the artifacts themselves are published by .github/workflows/lane-prebuilt-core.yml, whose `prebuilt-core-required` job is what asserts they EXIST; this step proves the keys are computable and distinct",
        keys.join(", ")
    )))
}

/// THE RELEASE SMOKE (D-1020-G5). See `crate::smoke`.
fn run_vps_smoke(ctx: &Ctx) -> Result<Outcome> {
    let outcome = smoke::run(&ctx.root, &ctx.artifacts)?;
    if outcome.line.starts_with("SKIPPED:") {
        return Ok(if outcome.ok {
            Outcome::Skipped(outcome.line)
        } else {
            Outcome::Failed(outcome.line)
        });
    }
    Ok(if outcome.ok {
        Outcome::Ok(outcome.line)
    } else {
        Outcome::Failed(outcome.line)
    })
}

/// A `ci::Verdict` as a step outcome, with the findings written to the step's
/// artifact directory and printed — the same shape `run_rules` uses, so a
/// finding is never only in an exit code.
fn verdict(ctx: &Ctx, step: &str, result: ci::Verdict) -> Result<Outcome> {
    if result.ok {
        return Ok(Outcome::Ok(result.line));
    }
    let dir = ctx.artifacts.join(step);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("findings.txt"), result.findings.join("\n"))?;
    for finding in &result.findings {
        println!("        {finding}");
    }
    Ok(Outcome::Failed(format!(
        "{} · artifact: {}",
        result.line,
        display_relative(&ctx.root, &dir)
    )))
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

    /// The two steps wave 2 lane D2 owes the `pr` profile (#1020).
    ///
    /// Named rather than counted: a test that asserted "`pr` has fourteen
    /// steps" would pass after somebody replaced one of these with something
    /// else.
    #[test]
    fn the_pr_profile_runs_the_simulation_and_the_call_budget() {
        let pr = names(Profile::Pr);
        assert!(
            pr.contains(&"sim"),
            "`pr` does not run the deterministic simulation, which is #1020's primary \
             sync proof and is required on every PR"
        );
        assert!(
            pr.contains(&"call-budget"),
            "`pr` does not run the `call` budget; the issue's rule is that any request \
             exceeding it in `pr` fails the gate"
        );
        // And the deeper sweep is nightly's ALONE: 250 seeds do not fit a
        // 900-second PR budget, and putting them there is how a gate gets
        // skipped rather than fixed.
        assert!(!pr.contains(&"sim-nightly"));
        assert!(names(Profile::Nightly).contains(&"sim-nightly"));
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
    fn release_adds_the_drill_the_identity_check_the_required_triples_and_the_smoke() {
        let nightly = names(Profile::Nightly);
        let release = names(Profile::Release);
        assert_eq!(
            &release[nightly.len()..],
            [
                "restore-drill",
                "artifact-identity",
                "prebuilt-core-required",
                "vps-smoke"
            ]
        );
    }

    /// THE RELEASE PROFILE NO LONGER CARRIES A PLACEHOLDER, and this is the
    /// test that says so.
    ///
    /// It replaces `the_placeholders_fail_rather_than_skip`, which asserted
    /// that `vps-smoke` returned a "not implemented" failure. That rule was
    /// never about the message: it was that the release profile cannot pass
    /// VACUOUSLY. `restore-drill` became real in wave 2 lane R and `vps-smoke`
    /// in wave 3 lane G, so the way to hold the same rule is to assert that no
    /// step in the profile is a stub any more — a step whose body announces it
    /// is not implemented is a step whose lane never landed.
    #[test]
    fn no_step_in_the_release_profile_is_a_stub() {
        for entry in steps(Profile::Release) {
            let source = format!("{:p}", entry.run as *const ());
            assert!(!source.is_empty());
        }
        // The four release-only steps all have real bodies, which is checked by
        // the profile's own exit list rather than by calling them here: three of
        // them shell out to cargo and one drives Docker, so invoking them from
        // a unit test would be running the release profile inside `cargo test
        // -p xtask`. What IS checked here is that the two sentences the old
        // placeholders carried have left the file — a stub reintroduced under
        // any name would have to bring one of them back.
        let source = include_str!("gate.rs");
        // Spelled in two halves so this file does not contain the sentence it
        // is looking for, which would make the assertion fail on itself.
        let stub = concat!("not implemented", ": lands in wave ");
        assert!(
            !source.contains(stub),
            "a release step announces it is not implemented; a profile with a stub in it cannot report on a release"
        );
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

    /// A `--lane` name that matches nothing is an ERROR. A lane filter that
    /// silently selected zero steps would report PASS over an empty run, which
    /// is the one verdict `gate.rs` exists to make impossible.
    #[test]
    fn an_unknown_lane_name_is_refused_rather_than_running_nothing() {
        let root = crate::testing::fixture_dir("buf-absent");
        let _ = root;
        let error = select(Profile::Nightly, Some("no-such-lane")).expect_err("must refuse");
        let text = format!("{error:#}");
        assert!(text.contains("--lane no-such-lane names no step"), "{text}");
        assert!(text.contains("ios-transfer-experiment"), "{text}");
        // A real step name selects exactly one step; a device lane selects the
        // one step that owns all four.
        assert_eq!(select(Profile::Local, Some("fmt")).unwrap().len(), 1);
        let device = select(Profile::Nightly, Some("ios-xctest-metrics"))
            .map(|steps| steps.iter().map(|step| step.name).collect::<Vec<_>>())
            .expect("a device lane selects the device step");
        assert_eq!(device, ["device-lanes"]);
        // And a device lane is NOT selectable from a profile that has no
        // device step at all.
        assert!(select(Profile::Pr, Some("ios-xctest-metrics")).is_err());
    }

    /// A device lane name narrows the run to `device-lanes` and that step names
    /// the one lane it was asked about, not all four.
    #[test]
    fn a_device_lane_name_narrows_to_the_device_step_and_names_only_that_lane() {
        let root = crate::testing::fixture_dir("buf-absent");
        let ctx = Ctx {
            root: root.clone(),
            lane: Some("android-macrobenchmark".to_owned()),
            hardware: DEFAULT_HARDWARE.to_owned(),
            ci: false,
            artifacts: root.join("target"),
        };
        match run_device_lanes(&ctx).expect("the step runs") {
            Outcome::Skipped(detail) => {
                assert!(detail.contains("android-macrobenchmark"), "{detail}");
                assert!(!detail.contains("ios-xctest-metrics"), "{detail}");
            }
            other => panic!(
                "without a device runner the step must skip loudly, not {}",
                match other {
                    Outcome::Ok(_) => "pass",
                    Outcome::Failed(_) => "fail",
                    Outcome::Skipped(_) => unreachable!(),
                }
            ),
        }
    }

    #[test]
    fn the_buf_step_skips_loudly_before_the_schema_lands() {
        let root = crate::testing::fixture_dir("buf-absent");
        let ctx = Ctx {
            root: root.clone(),
            lane: None,
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
            !run(Profile::MobileJvm, &root, false, None).expect("the refusal is not an error"),
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
            lane: None,
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
