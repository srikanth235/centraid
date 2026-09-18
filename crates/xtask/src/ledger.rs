//! The down-only ledgers under `contracts/ledgers/`.
//!
//! Three files, one rule: **every number may only fall.** `gate-budgets.json`
//! holds the per-profile feedback-time budget the issue sets, `compile-time.json`
//! the edit-run loop ("compile time is the new Hermes"), and
//! `library-size.json` the per-ABI core size the prebuilt-core lane fills in
//! wave 3. v0's ledgers live under `tests/` and retire with v0; these are v1's,
//! seeded from wave 1 measurements.
//!
//! The comparison mirrors `scripts/check-ledgers.mjs`: read the base copy with
//! `git show <merge-base>:<path>`, and treat "the base has no such file" as a
//! new entry that passes, because otherwise the very commit that introduces a
//! ledger could not pass its own gate. What is NOT mirrored is the waiver
//! mechanism — these ledgers have no `approvedDeviation` yet, so there is
//! nothing to launder, and a waiver added before the first widen is asked for
//! is an invitation.
//!
//! A gate run never writes a ledger. `cargo xtask measure --write` does. If the
//! runner wrote its own measurements back, the ratchet would be a recording of
//! whatever the last run happened to cost.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, anyhow};

pub const LEDGER_DIR: &str = "contracts/ledgers";
pub const BUDGETS: &str = "contracts/ledgers/gate-budgets.json";
pub const COMPILE_TIME: &str = "contracts/ledgers/compile-time.json";

/// The refs `check-ledgers.mjs` tries, in the same order.
const BASE_CANDIDATES: [&str; 4] = ["origin/main", "main", "origin/master", "master"];

pub struct LedgerVerdict {
    pub base: String,
    pub checked: Vec<String>,
    pub findings: Vec<String>,
}

/// Check every ledger in `contracts/ledgers/` against the merge base.
pub fn check(root: &Path) -> Result<LedgerVerdict> {
    let base = merge_base(root).ok_or_else(|| {
        anyhow!(
            "no merge base found (tried {}). Fetch the default branch — refusing to pass the down-only check without comparing against anything",
            BASE_CANDIDATES.join(", ")
        )
    })?;
    let dir = root.join(LEDGER_DIR);
    let mut checked = Vec::new();
    let mut findings = Vec::new();
    if !dir.is_dir() {
        findings.push(format!(
            "{LEDGER_DIR} is missing — the v1 ledgers are a wave 1 deliverable (#1020)"
        ));
        return Ok(LedgerVerdict {
            base,
            checked,
            findings,
        });
    }
    let mut files: Vec<_> = fs::read_dir(&dir)
        .with_context(|| format!("read {LEDGER_DIR}"))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    for file in files {
        let relative = format!(
            "{LEDGER_DIR}/{}",
            file.file_name().unwrap_or_default().to_string_lossy()
        );
        let head = fs::read_to_string(&file).with_context(|| format!("read {relative}"))?;
        let base_copy = show(root, &base, &relative);
        findings.extend(down_only_findings(&relative, base_copy.as_deref(), &head)?);
        checked.push(relative);
    }
    Ok(LedgerVerdict {
        base,
        checked,
        findings,
    })
}

/// Compare one ledger's numbers against its base copy.
///
/// `base` of `None` means the file did not exist at the merge base: every entry
/// is new, and new entries pass.
pub fn down_only_findings(path: &str, base: Option<&str>, head: &str) -> Result<Vec<String>> {
    let head_numbers =
        numbers(&serde_json::from_str(head).with_context(|| format!("{path} is not valid JSON"))?);
    let Some(base) = base else {
        return Ok(Vec::new());
    };
    let base_numbers = numbers(
        &serde_json::from_str(base)
            .with_context(|| format!("the base copy of {path} is not valid JSON"))?,
    );
    let mut findings = Vec::new();
    for (key, was) in &base_numbers {
        match head_numbers.get(key) {
            Some(now) if now > was => findings.push(format!(
                "{path}: `{key}` rose {was} → {now}. Every number in this ledger is a ceiling and may only fall (#1020)"
            )),
            None => findings.push(format!(
                "{path}: `{key}` was removed (it was {was}). Deleting a ceiling is the widest possible widen — restate it lower instead"
            )),
            _ => {}
        }
    }
    Ok(findings)
}

/// Every number in a JSON document, keyed by its dotted path.
///
/// `null` is not a number and is skipped on purpose: it is how `nightly` and
/// `release` say "unbounded", which the issue rules, and a null that later
/// becomes a number is a new entry rather than a rise.
pub fn numbers(value: &serde_json::Value) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    collect(value, String::new(), &mut out);
    out
}

fn collect(value: &serde_json::Value, prefix: String, out: &mut BTreeMap<String, f64>) {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(as_f64) = number.as_f64() {
                out.insert(prefix, as_f64);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let next = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                collect(child, next, out);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                collect(child, format!("{prefix}[{index}]"), out);
            }
        }
        _ => {}
    }
}

/// The merge base of `HEAD` and the first default-branch candidate that exists.
pub fn merge_base(root: &Path) -> Option<String> {
    for candidate in BASE_CANDIDATES {
        let probe = Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", candidate])
            .current_dir(root)
            .output()
            .ok()?;
        if !probe.status.success() {
            continue;
        }
        let merge = Command::new("git")
            .args(["merge-base", "HEAD", candidate])
            .current_dir(root)
            .output()
            .ok()?;
        if merge.status.success() {
            let sha = String::from_utf8_lossy(&merge.stdout).trim().to_owned();
            if !sha.is_empty() {
                return Some(sha);
            }
        }
    }
    None
}

/// `git show <ref>:<path>`, or `None` when the path did not exist at that ref.
fn show(root: &Path, base: &str, path: &str) -> Option<String> {
    let output = Command::new("git")
        .arg("show")
        .arg(format!("{base}:{path}"))
        .current_dir(root)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        None
    }
}

/// The budget for one profile on one hardware class, in seconds. `None` is
/// "unbounded", which the issue rules for `nightly` and `release`.
pub fn budget_seconds(root: &Path, profile: &str, hardware: &str) -> Result<Option<f64>> {
    let path = root.join(BUDGETS);
    let text = fs::read_to_string(&path).with_context(|| {
        format!(
            "{BUDGETS} is missing — a profile with no budget is not a budget (#1020). Seed it with `cargo xtask measure`"
        )
    })?;
    let document: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("{BUDGETS} is not valid JSON"))?;
    let entry = document
        .get("profiles")
        .and_then(|profiles| profiles.get(profile))
        .and_then(|entry| entry.get(hardware))
        .ok_or_else(|| {
            anyhow!(
                "{BUDGETS} has no `profiles.{profile}.{hardware}` entry — an unbudgeted profile on an unbudgeted hardware class cannot be scored"
            )
        })?;
    let seconds = entry.get("budgetSeconds").ok_or_else(|| {
        anyhow!("{BUDGETS}: `profiles.{profile}.{hardware}` has no `budgetSeconds`")
    })?;
    Ok(seconds.as_f64())
}

/// A ceiling from `compile-time.json`, in seconds, for one hardware class.
/// `None` when the key is absent — a ledger that has not stated a ceiling
/// cannot enforce one, and the caller says so rather than inventing a number.
pub fn compile_time_ceiling(root: &Path, hardware: &str, key: &str) -> Option<f64> {
    let text = fs::read_to_string(root.join(COMPILE_TIME)).ok()?;
    let document: serde_json::Value = serde_json::from_str(&text).ok()?;
    document
        .get("measurements")?
        .get(hardware)?
        .get(key)?
        .get("budgetSeconds")?
        .as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_flattened_by_dotted_path() {
        let document: serde_json::Value = serde_json::from_str(
            r#"{"profiles":{"local":{"h":{"budgetSeconds":120,"headroom":"x"}}},"n":null}"#,
        )
        .expect("valid json");
        let flat = numbers(&document);
        assert_eq!(flat.get("profiles.local.h.budgetSeconds"), Some(&120.0));
        assert_eq!(flat.len(), 1, "null and strings are not numbers: {flat:?}");
    }

    #[test]
    fn a_risen_number_is_a_finding() {
        let base = r#"{"a":{"budgetSeconds":100}}"#;
        let head = r#"{"a":{"budgetSeconds":101}}"#;
        let findings = down_only_findings("l.json", Some(base), head).expect("compare");
        assert_eq!(findings.len(), 1);
        assert!(findings[0].contains("rose 100 → 101"));
    }

    #[test]
    fn a_fallen_number_is_clean() {
        let base = r#"{"a":{"budgetSeconds":100}}"#;
        let head = r#"{"a":{"budgetSeconds":90}}"#;
        assert!(
            down_only_findings("l.json", Some(base), head)
                .expect("compare")
                .is_empty()
        );
    }

    #[test]
    fn a_removed_ceiling_is_a_finding() {
        let base = r#"{"a":{"budgetSeconds":100}}"#;
        let head = r#"{"a":{}}"#;
        let findings = down_only_findings("l.json", Some(base), head).expect("compare");
        assert_eq!(findings.len(), 1);
        assert!(findings[0].contains("was removed"));
    }

    #[test]
    fn a_new_ledger_with_no_base_copy_passes() {
        let head = r#"{"a":{"budgetSeconds":100}}"#;
        assert!(
            down_only_findings("l.json", None, head)
                .expect("compare")
                .is_empty()
        );
    }

    #[test]
    fn a_new_entry_in_an_existing_ledger_passes() {
        let base = r#"{"a":{"budgetSeconds":100}}"#;
        let head = r#"{"a":{"budgetSeconds":100},"b":{"budgetSeconds":9999}}"#;
        assert!(
            down_only_findings("l.json", Some(base), head)
                .expect("compare")
                .is_empty()
        );
    }

    #[test]
    fn an_empty_ledger_gates_nothing_and_says_so() {
        let head = r#"{"_comment":"seeded empty; wave 3 fills it","entries":{}}"#;
        assert!(numbers(&serde_json::from_str(head).expect("valid json")).is_empty());
        assert!(
            down_only_findings("library-size.json", Some(head), head)
                .expect("compare")
                .is_empty()
        );
    }
}
