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
        step("deny", run_deny),
        step("ci-policy", run_ci_policy),
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
        step("restore-drill", |_| {
            Ok(Outcome::Failed(
                "not implemented: lands in wave 2 lane R (backup snapshot, WAL stream, recovery kit, `centraid recover`, restore-and-re-pair)".to_owned(),
            ))
        }),
        step("vps-smoke", |_| {
            Ok(Outcome::Failed(
                "not implemented: lands in wave 3 lane G (release smoke on a clean VPS from the Docker image)".to_owned(),
            ))
        }),
    ]);
    release
}

/// Run a profile. Returns `true` when every step passed inside its budget.
pub fn run(profile: Profile, root: &Path) -> Result<bool> {
    let hardware =
        std::env::var("CENTRAID_GATE_HARDWARE").unwrap_or_else(|_| DEFAULT_HARDWARE.to_owned());
    let ctx = Ctx {
        root: root.to_path_buf(),
        hardware: hardware.clone(),
        ci: std::env::var_os("CI").is_some(),
        artifacts: root.join("target/xtask").join(profile.name()),
    };
    let budget = ledger::budget_seconds(root, profile.name(), &hardware)?;

    println!(
        "xtask gate — profile {} · hardware {hardware} · budget {}",
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

    if let Some(seconds) = budget {
        if total.as_secs_f64() > seconds {
            ok = false;
            println!(
                "\n  BUDGET the `{}` profile took {:.1}s against a {seconds:.0}s budget. The budget is the product's feedback-time promise, not a target — either the step above it got slower or the profile grew a step it should not carry (contracts/ledgers/gate-budgets.json, #1020)",
                profile.name(),
                total.as_secs_f64()
            );
        } else {
            println!("  BUDGET ok — {:.1}s of {seconds:.0}s", total.as_secs_f64());
        }
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

/// NOT here yet, and named so the omission is visible: `gitleaks` (secret
/// scanning) and `osv-scanner` (the lockfile advisory inventory) were also
/// `ci.yml` pull-request lanes, and they are also not v0 gates. They are absent
/// from this profile because BOTH ARE ALREADY RED on the tree as it stands —
/// `packages/model-runtime/LICENSES.md` trips gitleaks' `generic-api-key` rule,
/// and `astro@7.1.5` in `bun.lock` carries a CRITICAL (score 9.8) — so adding
/// them in wave 1 would import another change's red into every pull request
/// rather than gate anything. They are two `step(...)` lines and two `external`
/// calls once those two are fixed; see the wave 1 receipt's findings.
///
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
    if ctx.ci {
        return Ok(Outcome::Failed(format!(
            "`{program}` is not on PATH and this is CI, where the workflow installs it — a missing binary here is an infrastructure failure, not a skip. {install}"
        )));
    }
    Ok(Outcome::Skipped(format!(
        "`{program}` is not on PATH — {covers} was NOT checked. {install}"
    )))
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

    /// The repo-wide CI policy lane is not one of v0's gates, so taking ci.yml
    /// off `pull_request` must not take it off pull requests. It is a step of
    /// the gate that replaced it, and this test is what says so.
    #[test]
    fn pr_carries_the_ci_policy_step() {
        let pr = names(Profile::Pr);
        assert!(pr.contains(&"ci-policy"), "{pr:?}");
    }

    #[test]
    fn local_carries_the_five_cheap_steps() {
        assert_eq!(
            names(Profile::Local),
            ["fmt", "clippy", "test", "rules", "ledgers"]
        );
    }

    #[test]
    fn release_adds_exactly_the_two_unimplemented_placeholders() {
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
            if !matches!(entry.name, "restore-drill" | "vps-smoke") {
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

    #[test]
    fn the_step_line_states_the_verdict_first() {
        let elapsed = Duration::from_millis(1500);
        assert!(line("fmt", elapsed, &Outcome::Ok("cargo fmt".to_owned())).starts_with("ok "));
        assert!(line("deny", elapsed, &Outcome::Skipped("x".to_owned())).starts_with("SKIP "));
        assert!(line("test", elapsed, &Outcome::Failed("x".to_owned())).starts_with("FAIL "));
    }
}
