//! `data-pin`: the training data is for the tool contract the app serves, or it says it is not.
//!
//! `crates/assist/data.json` pins the data version the assistant is trained on (the data repo, the held-out repo, the
//! version) with the tool contract that version was rendered for: the tools mode and the hashes of the tool catalogue and
//! the static prompt, as `assist::record::runtime_hashes` computes them. The rule computes the runtime's hashes for
//! the pinned mode (the `runtime_hashes` example, offline) and requires them to equal the pin. A change to a tool's
//! wording, arguments or behaviour moves a hash and fails the rule, so a tool change cannot ship quietly past data that
//! was built for the old one.
//!
//! The pin also holds `catalog_hash`, the data catalogue's hash (`datagen`'s `Catalog::build`, BLAKE3 of its canonical
//! text). Only the `datagen` crate builds it, so the rule asks `datagen catalog` for the runtime's value (offline) and
//! compares it like the other two.
//!
//! The two ways out, both a visible decision: publish a new data version and update the pin, or mark the pin stale
//! with `"stale": {"since": "<what changed, one line>", "level": "wording|shape|behaviour|coverage", "at": {"tools_hash":
//! "…", "prompt_hash": "…", "catalog_hash": "…"}}` after running `datagen drift` (the level is its verdict; `at` is the
//! runtime's hashes the mark was made at). A stale pin passes and the rule prints a notice line, but only for the contract
//! it was marked at: when the runtime's hashes equal the pin's, `at` is not read; when they differ, `at` must hold the
//! runtime's value of every hash that moved, or the rule fails, printing the current hashes to copy into `at`. The pin's
//! own hashes are never edited to get past it.

use std::path::Path;

use serde_json::Value;

use crate::rules::RuleReport;

const NAME: &str = "data-pin";
/// Where the pin lives, from the repository root.
const PIN: &str = "crates/assist/data.json";
/// What a stale pin may say it is stale by, least to most work.
const LEVELS: [&str; 4] = ["wording", "shape", "behaviour", "coverage"];

/// The rule's verdict on `pin` against the runtime's `hashes` (`runtime_hashes`'s output: per mode, `tools_hash` and
/// `prompt_hash`): the findings and the notices, in plain words. A pure function, tested on fixtures.
#[must_use]
pub fn verdict(pin: &Value, hashes: &Value) -> (Vec<String>, Vec<String>) {
    let mut findings = Vec::new();
    let mut details = Vec::new();
    let text = |k: &str| pin.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    for key in [
        "repo",
        "heldout_repo",
        "version",
        "tools_mode",
        "tools_hash",
        "prompt_hash",
        "catalog_hash",
    ] {
        if text(key).is_none() {
            findings.push(format!("{PIN}: `{key}` is missing or empty"));
        }
    }
    if !findings.is_empty() {
        return (findings, details);
    }
    let (version, mode) = (
        text("version").unwrap_or(""),
        text("tools_mode").unwrap_or(""),
    );
    let Some(now) = hashes.get(mode) else {
        findings.push(format!(
            "{PIN}: tools mode `{mode}` is not one the runtime serves"
        ));
        return (findings, details);
    };
    // (key, what, runtime value, pinned value) for each hash that moved.
    let mut moved: Vec<(&str, &str, &str, &str)> = Vec::new();
    for (key, what, runtime) in [
        (
            "tools_hash",
            "the tool catalogue (the tools the model is shown)",
            now.get("tools_hash"),
        ),
        (
            "prompt_hash",
            "the static prompt (identity, system turn, rules)",
            now.get("prompt_hash"),
        ),
        (
            "catalog_hash",
            "the data catalogue (the kinds, verbs and fields the generator covers)",
            hashes.get("catalog_hash"),
        ),
    ] {
        let pinned = text(key).unwrap_or("");
        let runtime = runtime.and_then(Value::as_str).unwrap_or("");
        if pinned != runtime {
            moved.push((key, what, runtime, pinned));
        }
    }
    let differs: Vec<String> = moved
        .iter()
        .map(|(key, what, runtime, pinned)| {
            format!("{what}: {key} is {runtime} in the runtime, {pinned} in the pin")
        })
        .collect();
    let stale = match pin.get("stale") {
        None | Some(Value::Null) => None,
        Some(s) => {
            let since = s
                .get("since")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty());
            let level = s
                .get("level")
                .and_then(Value::as_str)
                .filter(|l| LEVELS.contains(l));
            if let (Some(since), Some(level)) = (since, level) {
                Some((since.to_owned(), level.to_owned(), s.get("at")))
            } else {
                findings.push(format!(
                    "{PIN}: `stale` needs a non-empty `since` (what changed, one line) and a `level` of {}",
                    LEVELS.join(", ")
                ));
                return (findings, details);
            }
        }
    };
    match (differs.is_empty(), stale) {
        (true, None) => {}
        (true, Some((since, level, _))) => details.push(format!(
            "notice: data {version} is marked stale ({level}) though the tool contract still hashes the same: {since}. Clear `stale` if it no longer holds."
        )),
        (false, Some((since, level, at))) => {
            // The mark covers only the contract it was made at: `at` must hold the runtime's value of every hash that moved.
            let covered = moved.iter().all(|(key, _, runtime, _)| {
                at.and_then(|a| a.get(*key))
                    .and_then(Value::as_str)
                    .is_some_and(|v| v == *runtime)
            });
            if covered {
                details.push(format!(
                    "notice: data {version} is marked stale ({level}): {since}. The tool contract no longer hashes to the data's ({}). It passes until the data is regenerated for `{level}` and the pin updated.",
                    differs.join("; ")
                ));
            } else {
                let now_hash = |k: &str| match k {
                    "catalog_hash" => hashes.get(k),
                    _ => now.get(k),
                }
                .and_then(Value::as_str)
                .unwrap_or("");
                findings.push(format!(
                    "data {version} is marked stale ({level}), but the contract moved again since it was marked: {}. A stale mark covers only the contract it was made at ({PIN} `stale.at`). Run `datagen drift --in <version dir>`, then update `stale` in {PIN} with the level it reports, `since`, and `\"at\": {{\"tools_hash\": \"{}\", \"prompt_hash\": \"{}\", \"catalog_hash\": \"{}\"}}`. Do not edit the pin's own `tools_hash`, `prompt_hash` or `catalog_hash`: they say what the data was built for.",
                    differs.join("; "),
                    now_hash("tools_hash"),
                    now_hash("prompt_hash"),
                    now_hash("catalog_hash"),
                ));
            }
        }
        (false, None) => findings.push(format!(
            "data {version} was built for a different tool contract than the runtime serves in mode `{mode}`: {}. Two ways out: publish a new data version and update {PIN}, or mark the pin stale in {PIN} (\"stale\": {{\"since\": \"<what changed>\", \"level\": \"{}\", \"at\": {{the runtime's hashes}}}}) after running `datagen drift --in <version dir>`, which says the level.",
            differs.join("; "),
            LEVELS.join("|")
        )),
    }
    (findings, details)
}

/// The rule: read the pin, ask the runtime for its hashes, and judge.
pub fn data_pin(root: &Path) -> RuleReport {
    let pin_text = match std::fs::read_to_string(root.join(PIN)) {
        Ok(t) => t,
        Err(e) => {
            return RuleReport::applied(NAME, 0, vec![format!("{PIN}: cannot be read: {e}")]);
        }
    };
    let pin: Value = match serde_json::from_str(&pin_text) {
        Ok(v) => v,
        Err(e) => return RuleReport::applied(NAME, 1, vec![format!("{PIN}: not JSON: {e}")]),
    };
    let hashes = match runtime_contract(root) {
        Ok(h) => h,
        Err(e) => {
            return RuleReport::applied(
                NAME,
                1,
                vec![format!("the runtime's hashes could not be read: {e}")],
            );
        }
    };
    let (findings, details) = verdict(&pin, &hashes);
    let mut report = RuleReport::applied(NAME, 1, findings);
    report.details = details;
    report
}

/// The runtime's hashes per mode plus a top-level `catalog_hash`. The catalogue is built by the `datagen` crate from the
/// runtime (`Catalog::build`, BLAKE3 of its canonical text, the value `datagen` stamps), so it is asked of `datagen
/// catalog`, offline; it does not depend on the tools mode.
fn runtime_contract(root: &Path) -> anyhow::Result<Value> {
    use anyhow::{Context, bail};
    let mut hashes = crate::model_pin::runtime_hashes(root)?;
    let out = std::process::Command::new("cargo")
        .args([
            "run",
            "-q",
            "-p",
            "centraid-datagen",
            "--bin",
            "datagen",
            "--",
            "catalog",
            "--out",
        ])
        .arg("/dev/null")
        .current_dir(root)
        .output()
        .context("run `datagen catalog`")?;
    if !out.status.success() {
        bail!(
            "`datagen catalog` failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let hash = stderr
        .lines()
        .find_map(|l| l.strip_prefix("catalog "))
        .and_then(|l| l.split_whitespace().next())
        .context("`datagen catalog` printed no catalogue hash")?;
    hashes["catalog_hash"] = Value::String(hash.to_owned());
    Ok(hashes)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::verdict;

    fn pin(stale: &Value) -> Value {
        json!({
            "repo": "o/data", "heldout_repo": "o/held", "version": "v0.3", "tools_mode": "sig",
            "tools_hash": "aaa", "prompt_hash": "bbb", "catalog_hash": "ccc", "tokenizer_blake3": null,
            "stale": stale,
        })
    }

    fn runtime(tools: &str, prompt: &str) -> Value {
        runtime_with_catalog(tools, prompt, "ccc")
    }

    fn runtime_with_catalog(tools: &str, prompt: &str, catalog: &str) -> Value {
        json!({"sig": {"tools_hash": tools, "prompt_hash": prompt}, "s2": {"tools_hash": "x", "prompt_hash": "y"}, "catalog_hash": catalog})
    }

    #[test]
    fn a_pin_that_equals_the_runtime_is_clean() {
        let (findings, details) = verdict(&pin(&Value::Null), &runtime("aaa", "bbb"));
        assert!(findings.is_empty() && details.is_empty(), "{findings:?}");
    }

    #[test]
    fn a_changed_hash_fails_in_plain_words_with_the_two_ways_out() {
        let (findings, _) = verdict(&pin(&Value::Null), &runtime("zzz", "bbb"));
        assert_eq!(findings.len(), 1);
        let text = &findings[0];
        assert!(
            text.contains("data v0.3 was built for a different tool contract")
                && text.contains("the tool catalogue")
                && text.contains("tools_hash is zzz in the runtime, aaa in the pin")
                && !text.contains("prompt_hash is")
                && text.contains("publish a new data version and update crates/assist/data.json")
                && text.contains("mark the pin stale")
                && text.contains("datagen drift")
                && text.contains("wording|shape|behaviour|coverage"),
            "{text}"
        );
        let (findings, _) = verdict(&pin(&Value::Null), &runtime("zzz", "yyy"));
        assert!(findings[0].contains("tools_hash") && findings[0].contains("prompt_hash"));
    }

    #[test]
    fn a_stale_pin_at_the_contract_it_was_marked_at_passes_and_prints_a_notice() {
        // Changed from the earlier test: the mark now carries `at`, the runtime's hashes at marking.
        let stale = json!({"since": "the read tool takes a new `order` argument", "level": "shape",
            "at": {"tools_hash": "zzz", "prompt_hash": "bbb", "catalog_hash": "ccc"}});
        let (findings, details) = verdict(&pin(&stale), &runtime("zzz", "bbb"));
        assert!(findings.is_empty(), "{findings:?}");
        assert_eq!(details.len(), 1);
        assert!(
            details[0].starts_with("notice: data v0.3 is marked stale (shape)")
                && details[0].contains("new `order` argument"),
            "{details:?}"
        );
    }

    #[test]
    fn a_stale_pin_whose_contract_moved_with_no_at_fails_naming_the_hashes() {
        let stale = json!({"since": "x", "level": "shape"});
        let (findings, details) = verdict(&pin(&stale), &runtime("zzz", "bbb"));
        assert!(details.is_empty(), "{details:?}");
        assert_eq!(findings.len(), 1);
        let text = &findings[0];
        assert!(
            text.contains("moved again")
                && text.contains("\"tools_hash\": \"zzz\"")
                && text.contains("\"prompt_hash\": \"bbb\"")
                && text.contains("\"catalog_hash\": \"ccc\"")
                && text.contains("datagen drift")
                && text.contains("Do not edit the pin's own"),
            "{text}"
        );
    }

    #[test]
    fn a_stale_pin_whose_contract_moved_again_after_the_mark_fails() {
        let stale = json!({"since": "x", "level": "shape",
            "at": {"tools_hash": "zzz", "prompt_hash": "bbb", "catalog_hash": "ccc"}});
        let (findings, _) = verdict(&pin(&stale), &runtime("yyy", "bbb"));
        assert_eq!(findings.len(), 1);
        assert!(
            findings[0].contains("tools_hash is yyy in the runtime, aaa in the pin")
                && findings[0].contains("\"tools_hash\": \"yyy\""),
            "{findings:?}"
        );
    }

    #[test]
    fn a_stale_pin_that_equals_the_runtime_passes_without_at() {
        let stale = json!({"since": "x", "level": "coverage"});
        let (findings, details) = verdict(&pin(&stale), &runtime("aaa", "bbb"));
        assert!(findings.is_empty(), "{findings:?}");
        assert_eq!(details.len(), 1);
    }

    #[test]
    fn a_moved_catalogue_hash_fails_when_not_stale_and_is_covered_by_at_when_stale() {
        let (findings, _) = verdict(
            &pin(&Value::Null),
            &runtime_with_catalog("aaa", "bbb", "new"),
        );
        assert_eq!(findings.len(), 1);
        assert!(
            findings[0].contains("the data catalogue")
                && findings[0].contains("catalog_hash is new in the runtime, ccc in the pin"),
            "{findings:?}"
        );
        let stale = json!({"since": "x", "level": "coverage", "at": {"catalog_hash": "new"}});
        let (findings, details) = verdict(&pin(&stale), &runtime_with_catalog("aaa", "bbb", "new"));
        assert!(findings.is_empty() && details.len() == 1, "{findings:?}");
    }

    #[test]
    fn a_stale_mark_needs_a_reason_and_a_known_level() {
        for bad in [
            json!({"since": "", "level": "shape"}),
            json!({"since": "x", "level": "tiny"}),
            json!({"level": "shape"}),
            json!("yes"),
        ] {
            let (findings, _) = verdict(&pin(&bad), &runtime("aaa", "bbb"));
            assert_eq!(findings.len(), 1, "{bad}");
            assert!(findings[0].contains("`stale` needs"), "{findings:?}");
        }
    }

    #[test]
    fn a_missing_field_or_an_unknown_mode_fails() {
        let mut broken = pin(&Value::Null);
        broken["tools_hash"] = Value::Null;
        assert!(verdict(&broken, &runtime("aaa", "bbb")).0[0].contains("`tools_hash` is missing"));
        let mut other = pin(&Value::Null);
        other["tools_mode"] = json!("nope");
        assert!(
            verdict(&other, &runtime("aaa", "bbb")).0[0].contains("not one the runtime serves")
        );
    }
}
