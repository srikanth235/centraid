//! `data-pin`: the training data is for the tool contract the app serves, or it says it is not.
//!
//! `crates/assist/data.json` pins the data version the assistant is trained on (the data repo, the held-out repo, the
//! version) with the tool contract that version was rendered for: the tools mode and the hashes of the tool catalogue and
//! the static prompt, as `assist::record::runtime_hashes` computes them. The rule computes the runtime's hashes for
//! the pinned mode (the `runtime_hashes` example, offline) and requires them to equal the pin. A change to a tool's
//! wording, arguments or behaviour moves a hash and fails the rule, so a tool change cannot ship quietly past data that
//! was built for the old one.
//!
//! The two ways out, both a visible decision: publish a new data version and update the pin, or mark the pin stale
//! with `"stale": {"since": "<what changed, one line>", "level": "wording|shape|behaviour|coverage"}` after running
//! `datagen drift` (the level is its verdict). A stale pin passes and the rule prints a notice line.

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
    let mut differs = Vec::new();
    for (key, what) in [
        (
            "tools_hash",
            "the tool catalogue (the tools the model is shown)",
        ),
        (
            "prompt_hash",
            "the static prompt (identity, system turn, rules)",
        ),
    ] {
        let pinned = text(key).unwrap_or("");
        let runtime = now.get(key).and_then(Value::as_str).unwrap_or("");
        if pinned != runtime {
            differs.push(format!(
                "{what}: {key} is {runtime} in the runtime, {pinned} in the pin"
            ));
        }
    }
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
                Some((since.to_owned(), level.to_owned()))
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
        (true, Some((since, level))) => details.push(format!(
            "notice: data {version} is marked stale ({level}) though the tool contract still hashes the same: {since}. Clear `stale` if it no longer holds."
        )),
        (false, Some((since, level))) => details.push(format!(
            "notice: data {version} is marked stale ({level}): {since}. The tool contract no longer hashes to the data's ({}). It passes until the data is regenerated for `{level}` and the pin updated.",
            differs.join("; ")
        )),
        (false, None) => findings.push(format!(
            "data {version} was built for a different tool contract than the runtime serves in mode `{mode}`: {}. Two ways out: publish a new data version and update {PIN}, or mark the pin stale in {PIN} (\"stale\": {{\"since\": \"<what changed>\", \"level\": \"{}\"}}) after running `datagen drift --in <version dir>`, which says the level.",
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
    let hashes = match crate::model_pin::runtime_hashes(root) {
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
        json!({"sig": {"tools_hash": tools, "prompt_hash": prompt}, "s2": {"tools_hash": "x", "prompt_hash": "y"}})
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
    fn a_stale_pin_passes_and_prints_a_notice() {
        let stale =
            json!({"since": "the read tool takes a new `order` argument", "level": "shape"});
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
