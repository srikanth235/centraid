//! The CI-shape gates re-homed out of `scripts/ci/**` (#1020, D-1020-G3).
//!
//! Gates about the *shape* of CI and the supply chain rather than about the
//! product. Each keeps the rule of the script it names:
//!
//! | here | from | what it holds |
//! |---|---|---|
//! | [`advisory`] | `scripts/ci/advisory-expiry.mjs` | a step that announces it will never fail has an owner, an issue and a date |
//! | [`lockfile`] | `scripts/ci/lockfile-lint.mjs` | no `http:` package URL, integrity markers present, no unknown registry — for **both** lockfiles now |
//! | [`evidence`] | `scripts/test-report/write-evidence.mjs` | the per-PR report has a row for the v1 gate |
//!
//! The lockfile lint reads `Cargo.lock` as well as `bun.lock`, because the
//! product's supply chain is Rust.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

/// The advisory register.
pub const ADVISORY: &str = "contracts/ledgers/advisory.json";

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
    if let Ok(text) = fs::read_to_string(root.join(ADVISORY)) {
        let document: serde_json::Value =
            serde_json::from_str(&text).with_context(|| format!("{ADVISORY} JSON"))?;
        let Some(steps) = document.get("steps").and_then(serde_json::Value::as_object) else {
            return Ok(rows);
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
                "{step} declares itself advisory and is not registered in {ADVISORY}. Register it with an owner, an issue and a revisitBy, or stop calling it advisory."
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
        // `sha512-` / `sha256-` are Subresource Integrity's own spelling, which
        // npm writes into a lockfile and this step only reads. Not Centraid's
        // naming, and therefore not what #1025 S4's one-hash rule governs
        // (D-1025-S4-5).
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
            verdict.findings[0].contains("is not registered in"),
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
}
