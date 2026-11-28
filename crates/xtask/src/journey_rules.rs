use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::rules::RuleReport;

const RETIRED: [&str; 3] = [
    "tests/experience-budgets/",
    "tests/budgets.json#qualityRigs",
    "tests/quality-rig-budgets.json",
];
const SEARCH_ROOTS: [&str; 4] = ["packages", "scripts", "tests", ".github"];
const SEARCH_SUFFIXES: [&str; 6] = [".ts", ".tsx", ".mjs", ".js", ".json", ".yml"];
const EXEMPT: [&str; 1] = ["tests/journeys.json"];
const NINE: [&str; 9] = [
    "cold-open",
    "warm-switch",
    "own-echo",
    "peer-echo",
    "converge",
    "share",
    "search",
    "scroll",
    "first-bootstrap",
];

fn collect_sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    if !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "node_modules" || name == "dist" {
            continue;
        }
        if path.is_dir() {
            collect_sources(&path, out);
        } else if SEARCH_SUFFIXES.iter().any(|s| name.ends_with(s)) {
            out.push(path);
        }
    }
}

pub fn lint_journey_ledger(root: &Path) -> Result<(usize, Vec<String>)> {
    let mut errors = Vec::new();
    let ledger_path = root.join("tests/journeys.json");
    let raw = fs::read_to_string(&ledger_path)
        .with_context(|| format!("read {}", ledger_path.display()))?;
    let ledger: Value =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", ledger_path.display()))?;
    let empty = serde_json::Map::new();
    let entries = ledger
        .get("entries")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let journeys = ledger.get("journeys").and_then(Value::as_object);
    let volumes = ledger.get("volumes").and_then(Value::as_object);
    let hardware_map = ledger.get("hardware").and_then(Value::as_object);

    for (key, entry) in entries {
        if key == "approvedDeviation" || key.starts_with('_') {
            continue;
        }
        let parts: Vec<&str> = key.split('/').collect();
        if parts.len() != 4 {
            errors.push(format!(
                "journey-ledger: \"{key}\" is not surface/journey/volume/hardware"
            ));
            continue;
        }
        let (surface, journey, volume, hardware) = (parts[0], parts[1], parts[2], parts[3]);
        if entry.get("surface").and_then(Value::as_str) != Some(surface)
            || entry.get("journey").and_then(Value::as_str) != Some(journey)
            || entry.get("volume").and_then(Value::as_str) != Some(volume)
            || entry.get("hardware").and_then(Value::as_str) != Some(hardware)
        {
            errors.push(format!(
                "journey-ledger: \"{key}\" disagrees with its own fields"
            ));
        }
        if !journeys.is_some_and(|m| m.contains_key(journey)) {
            errors.push(format!(
                "journey-ledger: \"{key}\" names undeclared journey {journey}"
            ));
        }
        if !volumes.is_some_and(|m| m.contains_key(volume)) {
            errors.push(format!(
                "journey-ledger: \"{key}\" names undeclared volume {volume}"
            ));
        }
        if !hardware_map.is_some_and(|m| m.contains_key(hardware)) {
            errors.push(format!(
                "journey-ledger: \"{key}\" names undeclared hardware {hardware}"
            ));
        }
        let spans = entry.get("spans").and_then(Value::as_array);
        let consumers = entry.get("consumers").and_then(Value::as_array);
        match (spans, consumers) {
            (Some(s), Some(c)) if s.is_empty() && c.is_empty() => {
                errors.push(format!(
                    "journey-ledger: \"{key}\" names no span and no consumer — a ceiling nothing measures and nothing asserts is not a gate"
                ));
            }
            (Some(_), Some(_)) => {}
            _ => {
                errors.push(format!(
                    "journey-ledger: \"{key}\" needs spans[] and consumers[]"
                ));
            }
        }
        if let Some(consumers) = consumers {
            for consumer in consumers {
                let Some(text) = consumer.as_str() else {
                    continue;
                };
                let file = text.split(' ').next().unwrap_or("");
                if !root.join(file).exists() {
                    errors.push(format!(
                        "journey-ledger: \"{key}\" names consumer {file}, which does not exist"
                    ));
                }
            }
        }
        if !entry.get("tolerancePercent").is_some_and(Value::is_number) {
            errors.push(format!(
                "journey-ledger: \"{key}\" needs a tolerancePercent — the paired candidate/PR run needs to know what slow-down this journey may absorb"
            ));
        }
        if let Some(metrics) = entry.get("metrics").and_then(Value::as_object) {
            for (name, metric) in metrics {
                let Some(obj) = metric.as_object() else {
                    continue;
                };
                let numbers: Vec<&str> = obj
                    .iter()
                    .filter(|(field, value)| value.is_number() && !field.starts_with('_'))
                    .map(|(field, _)| field.as_str())
                    .collect();
                let status = obj.get("status").and_then(Value::as_str);
                if status == Some("bound")
                    && !obj
                        .get("_provenance")
                        .and_then(|p| p.get("note"))
                        .is_some_and(Value::is_string)
                {
                    errors.push(format!(
                        "journey-ledger: \"{key}\"#{name} is a catastrophe bound with no _provenance.note arguing it"
                    ));
                }
                if status == Some("measured") && numbers.is_empty() {
                    errors.push(format!(
                        "journey-ledger: \"{key}\"#{name} is measured but ships no ceiling"
                    ));
                }
                if status == Some("unmeasured") && !numbers.is_empty() {
                    errors.push(format!(
                        "journey-ledger: \"{key}\"#{name} is unmeasured but ships {} — park it under a leading underscore or measure it",
                        numbers.join(", ")
                    ));
                }
            }
        }
    }

    let mut covered = BTreeSet::new();
    for entry in entries.values() {
        if let (Some(surface), Some(journey)) = (
            entry.get("surface").and_then(Value::as_str),
            entry.get("journey").and_then(Value::as_str),
        ) {
            covered.insert(format!("{surface}/{journey}"));
        }
    }
    for surface in ["mobile", "gateway"] {
        for journey in NINE {
            if !covered.contains(&format!("{surface}/{journey}")) {
                errors.push(format!(
                    "journey-ledger: no entry for {surface}/{journey} — an unmeasured entry with a reason is an answer, a missing row is not"
                ));
            }
        }
    }

    if let Some(rigs) = ledger.get("rigs").and_then(Value::as_object) {
        for (owner, rig) in rigs {
            if let Some(rig_entries) = rig.get("entries").and_then(Value::as_array) {
                for key_val in rig_entries {
                    if let Some(key) = key_val.as_str()
                        && !entries.contains_key(key)
                    {
                        errors.push(format!(
                            "journey-ledger: rig {owner} names missing entry {key}"
                        ));
                    }
                }
            }
        }
    }

    let mut scanned = 1usize;
    let mut files = Vec::new();
    for dir in SEARCH_ROOTS {
        collect_sources(&root.join(dir), &mut files);
    }
    for file in files {
        let rel = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        if EXEMPT.contains(&rel.as_str()) {
            continue;
        }
        scanned += 1;
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        for retired in RETIRED {
            if text.contains(retired) {
                errors.push(format!(
                    "journey-ledger: {rel} still names {retired} — the journey ledger replaced it"
                ));
            }
        }
    }

    Ok((scanned, errors))
}

pub fn rule_report(root: &Path) -> RuleReport {
    const NAME: &str = "journey-ledger";
    if !root.join("tests/journeys.json").is_file() {
        return RuleReport::pending(NAME, "no tests/journeys.json");
    }
    match lint_journey_ledger(root) {
        Ok((scanned, errors)) => RuleReport::applied(NAME, scanned, errors),
        Err(err) => RuleReport::applied(NAME, 0, vec![format!("journey-ledger: {err:#}")]),
    }
}

pub fn run_cli(root: &Path) -> Result<bool> {
    let (_, errors) = lint_journey_ledger(root)?;
    for err in &errors {
        eprintln!("{err}");
    }
    if errors.is_empty() {
        println!(
            "journey-ledger: ok — every entry names its volume, hardware, spans and consumers"
        );
        Ok(true)
    } else {
        println!("journey-ledger: {} problem(s)", errors.len());
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(ledger: Value, files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for sub in ["packages", "scripts", "tests", ".github"] {
            fs::create_dir_all(dir.path().join(sub)).expect("mkdir");
        }
        fs::write(
            dir.path().join("tests/journeys.json"),
            serde_json::to_string_pretty(&ledger).expect("json"),
        )
        .expect("write ledger");
        for (rel, body) in files {
            let p = dir.path().join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).expect("mkdir parent");
            }
            fs::write(p, body).expect("write file");
        }
        dir
    }

    fn base_journeys() -> serde_json::Map<String, Value> {
        NINE.iter()
            .map(|n| ((*n).to_owned(), Value::String(format!("the {n} journey"))))
            .collect()
    }

    fn grid(extra: Vec<(&str, Value)>) -> serde_json::Map<String, Value> {
        let mut map = serde_json::Map::new();
        for surface in ["desktop", "mobile", "gateway"] {
            for journey in NINE {
                map.insert(
                    format!("{surface}/{journey}/year3/any"),
                    json!({
                        "surface": surface,
                        "journey": journey,
                        "volume": "year3",
                        "hardware": "any",
                        "spans": ["x"],
                        "consumers": [],
                        "tolerancePercent": 20,
                        "metrics": {}
                    }),
                );
            }
        }
        for (k, v) in extra {
            map.insert(k.to_owned(), v);
        }
        map
    }

    fn make_entry(over: Value) -> Value {
        let mut base = json!({
            "surface": "desktop",
            "journey": "cold-open",
            "volume": "year3",
            "hardware": "any",
            "spans": ["desktop.boot"],
            "consumers": ["tests/probe.ts"],
            "tolerancePercent": 20,
            "metrics": { "coldOpen": { "status": "measured", "ceilingMs": 900 } }
        });
        if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
            for (k, v) in o {
                b.insert(k.clone(), v.clone());
            }
        }
        base
    }

    fn ledger_with(entries: serde_json::Map<String, Value>, rigs: Value) -> Value {
        json!({
            "hardware": { "any": "hardware-independent" },
            "volumes": { "year3": "the golden artifact" },
            "journeys": base_journeys(),
            "entries": entries,
            "rigs": rigs,
        })
    }

    #[test]
    fn hole_in_nine_journey_grid_fails() {
        let mut entries = serde_json::Map::new();
        entries.insert("mobile/cold-open/year3/any".into(), make_entry(json!({})));
        let dir = fixture(ledger_with(entries, json!({})), &[("tests/probe.ts", "")]);
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.join("\n").contains("no entry for mobile/share"));
    }

    #[test]
    fn approved_deviation_is_not_read_as_a_journey() {
        let mut entries = grid(vec![("desktop/cold-open/year3/any", make_entry(json!({})))]);
        entries.insert(
            "approvedDeviation".into(),
            Value::String("#927 W4 re-keyed the desktop rows onto year3.".into()),
        );
        let dir = fixture(
            ledger_with(entries, json!({})),
            &[("tests/probe.ts", "// the consumer")],
        );
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.is_empty(), "{errs:?}");
    }

    #[test]
    fn well_formed_ledger_passes() {
        let entries = grid(vec![("desktop/cold-open/year3/any", make_entry(json!({})))]);
        let dir = fixture(
            ledger_with(entries, json!({})),
            &[("tests/probe.ts", "// the consumer")],
        );
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.is_empty(), "{errs:?}");
    }

    #[test]
    fn key_disagreeing_with_fields_fails() {
        let mut entries = serde_json::Map::new();
        entries.insert(
            "desktop/cold-open/year3/any".into(),
            make_entry(json!({ "surface": "mobile" })),
        );
        let dir = fixture(ledger_with(entries, json!({})), &[("tests/probe.ts", "")]);
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.join("\n").contains("disagrees with its own fields"));
    }

    #[test]
    fn undeclared_volume_fails() {
        let entries = grid(vec![(
            "desktop/cold-open/huge/any",
            make_entry(json!({ "volume": "huge" })),
        )]);
        let dir = fixture(ledger_with(entries, json!({})), &[("tests/probe.ts", "")]);
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.join("\n").contains("undeclared volume huge"));
    }

    #[test]
    fn entry_with_no_span_and_no_consumer_fails() {
        let entries = grid(vec![(
            "desktop/cold-open/year3/any",
            make_entry(json!({ "spans": [], "consumers": [] })),
        )]);
        let dir = fixture(ledger_with(entries, json!({})), &[]);
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.join("\n").contains("names no span and no consumer"));
    }

    #[test]
    fn missing_consumer_fails() {
        let entries = grid(vec![("desktop/cold-open/year3/any", make_entry(json!({})))]);
        let dir = fixture(ledger_with(entries, json!({})), &[]);
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.join("\n").contains("which does not exist"));
    }

    #[test]
    fn unmeasured_metric_shipping_number_fails() {
        let entries = grid(vec![(
            "desktop/cold-open/year3/any",
            make_entry(json!({
                "metrics": { "coldOpen": { "status": "unmeasured", "ceilingMs": 900 } }
            })),
        )]);
        let dir = fixture(ledger_with(entries, json!({})), &[("tests/probe.ts", "")]);
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.join("\n").contains("unmeasured but ships"));
    }

    #[test]
    fn catastrophe_bound_must_argue_itself() {
        let entries = grid(vec![(
            "desktop/cold-open/year3/any",
            make_entry(json!({
                "metrics": { "coldOpen": { "status": "bound", "maxPercent": 50 } }
            })),
        )]);
        let dir = fixture(ledger_with(entries, json!({})), &[("tests/probe.ts", "")]);
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(
            errs.join("\n")
                .contains("catastrophe bound with no _provenance.note")
        );
    }

    #[test]
    fn rig_cross_link_to_missing_entry_fails() {
        let mut entries = serde_json::Map::new();
        entries.insert("desktop/cold-open/year3/any".into(), make_entry(json!({})));
        let dir = fixture(
            ledger_with(
                entries,
                json!({ "tests/perf/x.perf.test.ts": { "entries": ["web/gone/year3/any"] } }),
            ),
            &[("tests/probe.ts", "")],
        );
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(errs.join("\n").contains("names missing entry"));
    }

    #[test]
    fn surviving_reference_to_replaced_file_fails() {
        let entries = grid(vec![("desktop/cold-open/year3/any", make_entry(json!({})))]);
        let dir = fixture(
            ledger_with(entries, json!({})),
            &[
                ("tests/probe.ts", ""),
                (
                    "tests/old.ts",
                    r#"import x from "tests/experience-budgets/web.json";"#,
                ),
            ],
        );
        let (_, errs) = lint_journey_ledger(dir.path()).expect("lint");
        assert!(
            errs.join("\n")
                .contains("still names tests/experience-budgets/")
        );
    }
}
