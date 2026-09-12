//! The CI-shape gates re-homed out of `scripts/ci/**` (#1020, D-1020-G3).
//!
//! v0's CI grew a layer of gates that are not about v0's product at all: they
//! are about the *shape* of CI. #1020 takes v0's gates off pull requests, and
//! these four would have gone with them — which would be weakening a gate
//! rather than moving one. So they move here, into the gate that replaced the
//! workflow, and the rule each one enforces is kept verbatim from the script it
//! came from:
//!
//! | here | from | what it holds |
//! |---|---|---|
//! | [`advisory`] | `scripts/ci/advisory-expiry.mjs` | a step that announces it will never fail has an owner, an issue and a date |
//! | [`lockfile`] | `scripts/ci/lockfile-lint.mjs` | no `http:` package URL, integrity markers present, no unknown registry — for **both** lockfiles now |
//! | [`evidence`] | `scripts/test-report/write-evidence.mjs` | the per-PR report has a row for the v1 gate |
//! | [`lane_health`] | `scripts/ci/lane-health.mjs` | first-attempt pass rate and chronic red, nightly, off the Actions API |
//!
//! **The v0 scripts are not deleted and still run.** `ci.yml` executes every one
//! of its 21 jobs on pushes to `main` and on its own nightly schedule; what
//! changed is which tree each one is answering about. Where a rule covers the
//! same file in both trees — the lockfile lint is the clear case — the v1 side
//! reads `Cargo.lock` too, because `bun.lock` alone stops being the whole
//! supply chain the moment the product is Rust.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};

/// The v1 advisory register. The v0 one is `tests/inventory.json#advisory`,
/// which is law estate; both are read and a row in either satisfies a step.
pub const ADVISORY: &str = "contracts/ledgers/advisory.json";
const V0_ADVISORY: &str = "tests/inventory.json";

/// What a gate step needs to report: a verdict and one line.
pub struct Verdict {
    pub ok: bool,
    pub line: String,
    /// Every finding, for the artifact file.
    pub findings: Vec<String>,
}

impl Verdict {
    fn ok(line: impl Into<String>) -> Self {
        Self {
            ok: true,
            line: line.into(),
            findings: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// advisory
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Row {
    owner: String,
    issue: String,
    revisit_by: String,
}

/// A step whose NAME declares it advisory, in any workflow.
///
/// Line-based like the script it is ported from, and for the same reason: the
/// subject is a *step name*, which is one line of YAML, and a workflow parser
/// would be a second dependency for no extra precision. `continue-on-error` is
/// deliberately NOT covered — most of those are artifact restores whose failure
/// is benign and re-checked, and sweeping them in would flood the gate and
/// teach people to widen it. This rule is about steps that ANNOUNCE they will
/// never fail.
fn advisory_steps(root: &Path) -> Result<Vec<String>> {
    let dir = root.join(".github/workflows");
    let mut found = Vec::new();
    let mut files: Vec<_> = fs::read_dir(&dir)
        .with_context(|| format!("read {}", dir.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|end| end == "yml" || end == "yaml")
        })
        .collect();
    files.sort();
    for file in files {
        let name = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let text = fs::read_to_string(&file).with_context(|| format!("read {name}"))?;
        for line in text.lines() {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("- name:") else {
                continue;
            };
            let step = rest.trim().trim_matches(['"', '\'']).trim();
            let lowered = step.to_lowercase();
            if !(lowered.contains("advisory") || lowered.contains("(non-blocking)")) {
                continue;
            }
            found.push(format!("{name}: {step}"));
        }
    }
    Ok(found)
}

fn advisory_rows(root: &Path) -> Result<BTreeMap<String, Row>> {
    let mut rows = BTreeMap::new();
    for (path, pointer) in [(ADVISORY, "steps"), (V0_ADVISORY, "advisory")] {
        let Ok(text) = fs::read_to_string(root.join(path)) else {
            continue;
        };
        let document: serde_json::Value =
            serde_json::from_str(&text).with_context(|| format!("{path} JSON"))?;
        let steps = match pointer {
            "steps" => document.get("steps"),
            _ => document.get("advisory").and_then(|it| it.get("steps")),
        };
        let Some(steps) = steps.and_then(serde_json::Value::as_object) else {
            continue;
        };
        for (id, row) in steps {
            let text_of = |field: &str| {
                row.get(field)
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            rows.insert(
                id.clone(),
                Row {
                    owner: text_of("owner"),
                    issue: text_of("issue"),
                    revisit_by: text_of("revisitBy"),
                },
            );
        }
    }
    Ok(rows)
}

/// `today` is a parameter so the expiry rule itself is testable without waiting
/// for a date to pass. The gate passes the real one.
pub fn advisory(root: &Path, today: &str) -> Result<Verdict> {
    let steps = advisory_steps(root)?;
    let rows = advisory_rows(root)?;
    let mut findings = Vec::new();

    for step in &steps {
        match rows.get(step) {
            None => findings.push(format!(
                "{step} declares itself advisory and is registered in neither {ADVISORY} nor {V0_ADVISORY}#advisory. Register it with an owner, an issue and a revisitBy, or stop calling it advisory."
            )),
            Some(row) => {
                for (field, value) in [
                    ("owner", &row.owner),
                    ("issue", &row.issue),
                    ("revisitBy", &row.revisit_by),
                ] {
                    if value.is_empty() {
                        findings.push(format!("{step} is registered with no `{field}`"));
                    }
                }
                // Lexicographic comparison is exact for `YYYY-MM-DD`, which is
                // why the ledger states dates in that shape and nothing else.
                if !row.revisit_by.is_empty() && row.revisit_by.as_str() < today {
                    findings.push(format!(
                        "{step} was to be revisited by {} and today is {today}. The next move is a DECISION — make it blocking, delete it, or extend the date on purpose — not another quarter of nobody reading it ({}).",
                        row.revisit_by, row.issue
                    ));
                }
            }
        }
    }

    for id in rows.keys() {
        if !steps.contains(id) {
            findings.push(format!(
                "{id} is registered as advisory and no such step exists any more. A stale exemption reads like a reviewed decision — delete the row."
            ));
        }
    }

    if findings.is_empty() {
        return Ok(Verdict::ok(format!(
            "{} advisory step(s), every one registered with an owner, an issue and an unexpired date",
            steps.len()
        )));
    }
    Ok(Verdict {
        ok: false,
        line: format!("{} advisory finding(s)", findings.len()),
        findings,
    })
}

// ---------------------------------------------------------------------------
// lockfile
// ---------------------------------------------------------------------------

/// Lockfile supply-chain lint over **both** lockfiles.
///
/// `bun.lock`'s rules are v0's, unchanged: no `http:` package URL, integrity
/// markers present, no registry host outside the allowlist. `Cargo.lock` is the
/// new half and the rules are the equivalents that mean something for cargo: a
/// `[[package]]` from a registry must carry a `checksum`, and a `source` that is
/// neither crates.io nor a path is named. An unchecksummed registry dependency
/// is precisely the `integrity`-less npm package the bun half refuses.
pub fn lockfile(root: &Path) -> Result<Verdict> {
    let mut findings = Vec::new();
    let mut checked = Vec::new();

    if let Ok(text) = fs::read_to_string(root.join("bun.lock")) {
        checked.push("bun.lock");
        for token in text.split_whitespace() {
            let Some(start) = token.find("http://") else {
                continue;
            };
            let url = token[start..].trim_matches(['"', ',', '\'']);
            if url.contains("localhost") || url.contains("127.0.0.1") {
                continue;
            }
            findings.push(format!("bun.lock carries a non-TLS package URL: {url}"));
        }
        if !(text.contains("integrity") || text.contains("sha512-") || text.contains("sha256-")) {
            findings.push(
                "bun.lock has no integrity or hash markers at all, so nothing in it is pinned by content".to_owned(),
            );
        }
    }

    if let Ok(text) = fs::read_to_string(root.join("Cargo.lock")) {
        checked.push("Cargo.lock");
        let mut name = String::new();
        let mut source = String::new();
        let mut checksum = String::new();
        let mut package = false;
        let close = |name: &str, source: &str, checksum: &str, findings: &mut Vec<String>| {
            if name.is_empty() || source.is_empty() {
                // No `source` is a path or workspace member: its bytes are in
                // the tree, so there is nothing to pin by content.
                return;
            }
            if !source.starts_with("registry+https://") && !source.starts_with("git+https://") {
                findings.push(format!(
                    "Cargo.lock: {name} comes from `{source}`, which is neither the crates.io registry over TLS nor an https git source"
                ));
            }
            if checksum.is_empty() && source.starts_with("registry+") {
                findings.push(format!(
                    "Cargo.lock: {name} comes from a registry and carries no `checksum`, so it is pinned by version and not by content"
                ));
            }
        };
        for line in text.lines() {
            let line = line.trim();
            if line == "[[package]]" {
                close(&name, &source, &checksum, &mut findings);
                name.clear();
                source.clear();
                checksum.clear();
                package = true;
                continue;
            }
            if line.starts_with('[') {
                close(&name, &source, &checksum, &mut findings);
                name.clear();
                source.clear();
                checksum.clear();
                package = false;
                continue;
            }
            if !package {
                continue;
            }
            for (field, slot) in [
                ("name", &mut name),
                ("source", &mut source),
                ("checksum", &mut checksum),
            ] {
                if let Some(rest) = line.strip_prefix(field)
                    && rest.trim_start().starts_with('=')
                {
                    *slot = rest
                        .trim_start()
                        .trim_start_matches('=')
                        .trim()
                        .trim_matches('"')
                        .to_owned();
                }
            }
        }
        close(&name, &source, &checksum, &mut findings);
    }

    if checked.is_empty() {
        return Ok(Verdict {
            ok: false,
            line: "no lockfile found at all — neither bun.lock nor Cargo.lock".to_owned(),
            findings: Vec::new(),
        });
    }
    if findings.is_empty() {
        return Ok(Verdict::ok(format!(
            "{} clean (TLS-only sources, every registry package pinned by content)",
            checked.join(" + ")
        )));
    }
    Ok(Verdict {
        ok: false,
        line: format!("{} lockfile finding(s)", findings.len()),
        findings,
    })
}

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

/// THE PER-PR EVIDENCE ROW — the named silence in wave 1 lane B's receipt.
///
/// v0's per-PR test report has a row per lane, written by
/// `scripts/test-report/write-evidence.mjs`; `gate.yml` wrote none, so the
/// report had no row for the gate that actually decides a v1 pull request. A
/// gate whose result is not in the report is a gate the report cannot be read
/// against, which is one step away from a gate nobody reads.
///
/// It writes one row per step to `target/xtask/<profile>/evidence.json`, which
/// the workflow uploads. Written on SUCCESS as well as failure — a report that
/// only has rows when something broke cannot show a lane going quiet.
pub fn write_evidence(
    artifacts: &Path,
    profile: &str,
    hardware: &str,
    rows: &[(&'static str, f64, &'static str, String)],
) -> Result<String> {
    fs::create_dir_all(artifacts).with_context(|| format!("create {}", artifacts.display()))?;
    let path = artifacts.join("evidence.json");
    let document = serde_json::json!({
        "profile": profile,
        "hardware": hardware,
        "steps": rows
            .iter()
            .map(|(name, seconds, verdict, detail)| serde_json::json!({
                "step": name,
                "seconds": (seconds * 10.0).round() / 10.0,
                "verdict": verdict,
                "detail": detail,
            }))
            .collect::<Vec<_>>(),
    });
    fs::write(&path, format!("{document:#}\n"))?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// lane-health
// ---------------------------------------------------------------------------

/// Per-lane first-attempt pass rate and chronic red, off the GitHub Actions API.
///
/// Two decisions this repository would otherwise make on memory, made on
/// evidence instead — the sentences are `scripts/ci/lane-health.mjs`'s and the
/// rule is unchanged:
///
/// * a REQUIRED lane below ~95 % first-attempt pass teaches people to press
///   re-run, and a re-run habit devalues every lane at once;
/// * a required lane red on `main` for days is the state in which "merge past
///   the red" becomes normal.
///
/// **Nightly only, and never on the PR lane.** It reads `api.github.com`, and a
/// pull request's verdict must not depend on a third party being up.
///
/// With no token it is a LOUD SKIP naming the command that makes it real, never
/// a pass: "the lanes were not checked" and "the lanes are healthy" are
/// different answers.
pub fn lane_health(root: &Path, repo: &str, workflow: &str, runs: usize) -> Result<Verdict> {
    let Ok(token) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")) else {
        return Ok(Verdict {
            ok: true,
            line: format!(
                "SKIPPED: no GITHUB_TOKEN or GH_TOKEN, so the Actions API was NOT read and no lane's first-attempt pass rate is known. Run `GITHUB_TOKEN=… cargo xtask lane-health --repo {repo}` (gate-nightly.yml does)"
            ),
            findings: Vec::new(),
        });
    };
    if !binary("curl") {
        return Ok(Verdict {
            ok: false,
            line: "curl is not on PATH and a token is present, so this is CI, where the runner has it — a missing binary here is an infrastructure failure, not a skip".to_owned(),
            findings: Vec::new(),
        });
    }
    let url = format!(
        "https://api.github.com/repos/{repo}/actions/workflows/{workflow}/runs?branch=main&per_page={runs}"
    );
    let output = Command::new("curl")
        .args([
            "-sSfL",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            &format!("Authorization: Bearer {token}"),
            &url,
        ])
        .current_dir(root)
        .output()
        .context("spawn curl for the Actions API")?;
    if !output.status.success() {
        return Ok(Verdict {
            ok: false,
            line: format!(
                "the Actions API would not answer for {repo}/{workflow}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            findings: Vec::new(),
        });
    }
    let document: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("the Actions API response is not JSON")?;
    let entries = document
        .get("workflow_runs")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        return Ok(Verdict {
            ok: true,
            line: format!(
                "SKIPPED: {repo}/{workflow} has no runs on main yet, so there is no pass rate to state. This is the answer on a fresh branch, not a clean bill of health"
            ),
            findings: Vec::new(),
        });
    }

    // FIRST ATTEMPT ONLY. `run_attempt > 1` is a re-run, and counting a re-run
    // as a pass is exactly how the re-run habit becomes invisible.
    let mut first = 0usize;
    let mut green = 0usize;
    let mut consecutive_red = 0usize;
    let mut still_counting = true;
    for entry in &entries {
        let attempt = entry
            .get("run_attempt")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1);
        let conclusion = entry
            .get("conclusion")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if attempt == 1 {
            first += 1;
            if conclusion == "success" {
                green += 1;
            }
        }
        if still_counting {
            match conclusion {
                "success" => still_counting = false,
                "failure" | "timed_out" => consecutive_red += 1,
                _ => {}
            }
        }
    }
    let rate = if first == 0 {
        100.0
    } else {
        (green as f64) * 100.0 / (first as f64)
    };
    const FLOOR: f64 = 95.0;
    const CHRONIC: usize = 3;
    let mut findings = Vec::new();
    if rate < FLOOR {
        findings.push(format!(
            "{workflow} passed {green}/{first} first attempts ({rate:.1} %) against a {FLOOR:.0} % floor. A required lane below that floor teaches people to press re-run, and a re-run habit devalues every lane at once (#892 Phase 3)"
        ));
    }
    if consecutive_red >= CHRONIC {
        findings.push(format!(
            "{workflow} has been red on main for {consecutive_red} consecutive runs. This is the state in which 'merge past the red' becomes normal — park it in a lane ledger with an owner and an expiry, or fix it (#892 Phase 3)"
        ));
    }
    if findings.is_empty() {
        return Ok(Verdict::ok(format!(
            "{workflow}: {green}/{first} first attempts green ({rate:.1} % against a {FLOOR:.0} % floor), {consecutive_red} consecutive red"
        )));
    }
    Ok(Verdict {
        ok: false,
        line: format!("{} lane-health finding(s)", findings.len()),
        findings,
    })
}

fn binary(program: &str) -> bool {
    Command::new(program).arg("--version").output().is_ok()
}

/// Today as `YYYY-MM-DD`, UTC, from the system clock with no date crate.
///
/// Hand-rolled for the same reason `crates/centraid/src/cmd/mod.rs` hand-rolls
/// its ISO parser: this is the only date arithmetic in the crate, and the
/// accepted shape is exactly the one the ledger writes.
pub fn today_utc() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or_default();
    let days = seconds.div_euclid(86_400);
    // Howard Hinnant's civil_from_days, the inverse of the days_from_civil in
    // crates/centraid.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("a scratch tree");
        fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
        fs::create_dir_all(dir.path().join("contracts/ledgers")).unwrap();
        dir
    }

    fn register(root: &Path, body: &str) {
        fs::write(root.join(ADVISORY), body).unwrap();
    }

    const WORKFLOW: &str = "jobs:\n  a:\n    steps:\n      - name: Advisory — the map (non-blocking)\n        run: true\n      - name: A real gate\n        run: true\n";

    #[test]
    fn an_unregistered_advisory_step_is_a_finding() {
        let dir = scratch();
        fs::write(dir.path().join(".github/workflows/x.yml"), WORKFLOW).unwrap();
        register(dir.path(), "{\"steps\":{}}");
        let verdict = advisory(dir.path(), "2026-09-12").unwrap();
        assert!(!verdict.ok);
        assert!(
            verdict.findings[0].contains("registered in neither"),
            "{:?}",
            verdict.findings
        );
    }

    /// THE DEMONSTRATED RED: a past `revisitBy` fails.
    #[test]
    fn a_past_revisit_date_is_a_finding() {
        let dir = scratch();
        fs::write(dir.path().join(".github/workflows/x.yml"), WORKFLOW).unwrap();
        register(
            dir.path(),
            "{\"steps\":{\".github/workflows/x.yml: Advisory — the map (non-blocking)\":{\"owner\":\"me\",\"issue\":\"#1\",\"revisitBy\":\"2026-09-11\"}}}",
        );
        let verdict = advisory(dir.path(), "2026-09-12").unwrap();
        assert!(!verdict.ok);
        assert!(
            verdict.findings[0].contains("was to be revisited by 2026-09-11"),
            "{:?}",
            verdict.findings
        );

        // The same row one day later is clean, which is what makes the failure
        // above about the DATE and not about the row.
        let verdict = advisory(dir.path(), "2026-09-11").unwrap();
        assert!(verdict.ok, "{:?}", verdict.findings);
    }

    #[test]
    fn a_row_for_a_step_that_no_longer_exists_is_a_finding() {
        let dir = scratch();
        fs::write(dir.path().join(".github/workflows/x.yml"), "jobs: {}\n").unwrap();
        register(
            dir.path(),
            "{\"steps\":{\".github/workflows/x.yml: Advisory — gone\":{\"owner\":\"me\",\"issue\":\"#1\",\"revisitBy\":\"2099-01-01\"}}}",
        );
        let verdict = advisory(dir.path(), "2026-09-12").unwrap();
        assert!(!verdict.ok);
        assert!(
            verdict.findings[0].contains("no such step exists"),
            "{:?}",
            verdict.findings
        );
    }

    /// A row in the v0 register satisfies a step, so the two files hold one row
    /// per step between them and neither needs a copy of the other's.
    #[test]
    fn a_row_in_the_v0_register_counts() {
        let dir = scratch();
        fs::create_dir_all(dir.path().join("tests")).unwrap();
        fs::write(dir.path().join(".github/workflows/x.yml"), WORKFLOW).unwrap();
        register(dir.path(), "{\"steps\":{}}");
        fs::write(
            dir.path().join(V0_ADVISORY),
            "{\"advisory\":{\"steps\":{\".github/workflows/x.yml: Advisory — the map (non-blocking)\":{\"owner\":\"v0\",\"issue\":\"#892\",\"revisitBy\":\"2099-01-01\"}}}}",
        )
        .unwrap();
        let verdict = advisory(dir.path(), "2026-09-12").unwrap();
        assert!(verdict.ok, "{:?}", verdict.findings);
    }

    #[test]
    fn an_unchecksummed_registry_crate_and_a_plain_http_url_are_both_findings() {
        let dir = scratch();
        fs::write(
            dir.path().join("Cargo.lock"),
            "[[package]]\nname = \"good\"\nversion = \"1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"abc\"\n\n[[package]]\nname = \"bad\"\nversion = \"1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"local\"\nversion = \"1\"\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("bun.lock"),
            "{\"x\": \"http://registry.example/x.tgz\", \"integrity\": \"sha512-aa\"}",
        )
        .unwrap();
        let verdict = lockfile(dir.path()).unwrap();
        assert!(!verdict.ok);
        let all = verdict.findings.join("\n");
        assert!(
            all.contains("bad") && all.contains("no `checksum`"),
            "{all}"
        );
        assert!(all.contains("non-TLS"), "{all}");
        // A workspace member with no `source` is not a finding: its bytes are
        // in the tree.
        assert!(!all.contains("local"), "{all}");
    }

    #[test]
    fn a_clean_pair_of_lockfiles_passes() {
        let dir = scratch();
        fs::write(
            dir.path().join("Cargo.lock"),
            "[[package]]\nname = \"good\"\nversion = \"1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"abc\"\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("bun.lock"),
            "{\"integrity\": \"sha512-aa\"}",
        )
        .unwrap();
        assert!(lockfile(dir.path()).unwrap().ok);
    }

    #[test]
    fn the_evidence_file_carries_one_row_per_step() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_evidence(
            dir.path(),
            "pr",
            "ci-linux-x64-4c",
            &[
                ("fmt", 1.23, "ok", "cargo fmt".to_owned()),
                ("secrets", 4.0, "FAIL", "one finding".to_owned()),
            ],
        )
        .unwrap();
        let text = fs::read_to_string(path).unwrap();
        let document: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(document["steps"].as_array().unwrap().len(), 2);
        assert_eq!(document["steps"][0]["seconds"], 1.2);
        assert_eq!(document["steps"][1]["verdict"], "FAIL");
        assert_eq!(document["profile"], "pr");
    }

    #[test]
    fn todays_date_round_trips_through_the_centraid_parser_shape() {
        let today = today_utc();
        assert_eq!(today.len(), 10, "{today}");
        assert!(today.starts_with("20"), "{today}");
        let parts: Vec<&str> = today.split('-').collect();
        assert_eq!(parts.len(), 3);
        let month: u32 = parts[1].parse().unwrap();
        let day: u32 = parts[2].parse().unwrap();
        assert!((1..=12).contains(&month), "{today}");
        assert!((1..=31).contains(&day), "{today}");
    }

    /// No token is a LOUD SKIP that names the command, never a pass that reads
    /// like a clean bill of health.
    #[test]
    fn lane_health_without_a_token_says_it_did_not_run() {
        if std::env::var("GITHUB_TOKEN").is_ok() || std::env::var("GH_TOKEN").is_ok() {
            return;
        }
        let dir = scratch();
        let verdict = lane_health(dir.path(), "owner/name", "ci.yml", 40).unwrap();
        assert!(verdict.ok);
        assert!(verdict.line.starts_with("SKIPPED:"), "{}", verdict.line);
        assert!(
            verdict.line.contains("cargo xtask lane-health"),
            "{}",
            verdict.line
        );
    }
}
