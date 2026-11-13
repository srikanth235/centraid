//! THE MODEL RECORD AGAINST THE RUNTIME (#1188 C1). The gate's `model-record` step runs this file: a
//! build whose `model.json` does not match the tool catalogue and prompt this runtime computes, or
//! whose pin is not a Hugging Face file at a commit, does not ship.

use centraid_assist::record::{self, Entry};

fn entries() -> Vec<(&'static str, Entry)> {
    let record = record::record();
    let mut out = vec![("current", record.current)];
    out.extend(record.previous.map(|entry| ("previous", entry)));
    out
}

#[test]
fn every_pinned_model_matches_the_runtime_it_runs_on() {
    for (which, entry) in entries() {
        let problems = record::problems(&entry);
        assert!(problems.is_empty(), "{which}: {problems:#?}");
    }
}

#[test]
fn the_adapter_a_release_ships_is_made_for_this_base_and_this_runtime() {
    let problems = record::adapter_problems(&record::record());
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn a_drifted_adapter_is_refused() {
    let base = record::record();
    let good = record::Adapter {
        url: format!(
            "https://huggingface.co/acme/a/resolve/{}/a.gguf",
            "d".repeat(40)
        ),
        file_name: "a.gguf".to_owned(),
        sha256: "e".repeat(64),
        bytes: 9,
        base_sha256: base.current.sha256.clone(),
        tools_hash: base.current.tools_hash.clone(),
        prompt_hash: base.current.prompt_hash.clone(),
        score: Some(0.5),
    };
    let with = |adapter: record::Adapter| record::Record {
        adapter: Some(adapter),
        ..base.clone()
    };
    assert!(record::adapter_problems(&with(good.clone())).is_empty());
    let mut other = good.clone();
    other.base_sha256 = "0".repeat(64);
    assert!(
        record::adapter_problems(&with(other))
            .iter()
            .any(|p| p.contains("trained on base"))
    );
    let mut other = good.clone();
    other.tools_hash = "0".repeat(64);
    assert!(
        record::adapter_problems(&with(other))
            .iter()
            .any(|p| p.contains("tools_hash"))
    );
    let mut other = good.clone();
    other.prompt_hash = "0".repeat(64);
    assert!(
        record::adapter_problems(&with(other))
            .iter()
            .any(|p| p.contains("prompt_hash"))
    );
    let mut other = good;
    other.url = "https://huggingface.co/acme/a/resolve/main/a.gguf".to_owned();
    assert!(
        record::adapter_problems(&with(other))
            .iter()
            .any(|p| p.contains("pinned to a commit"))
    );
}

#[test]
fn a_record_with_no_adapter_is_unchanged_on_the_wire() {
    let record = record::record();
    let text = serde_json::to_string(&record).unwrap();
    assert!(!text.contains("adapter"));
}

#[test]
fn the_two_model_window_never_pins_the_same_file_twice() {
    let record = record::record();
    if let Some(previous) = record.previous {
        assert_ne!(previous.sha256, record.current.sha256);
        assert_ne!(previous.url, record.current.url);
    }
}

#[test]
fn a_drifted_record_is_refused() {
    let mut entry = record::record().current;
    entry.tools_hash = "0".repeat(64);
    assert!(
        record::problems(&entry)
            .iter()
            .any(|p| p.contains("tools_hash"))
    );
    let mut entry = record::record().current;
    entry.prompt_hash = "f".repeat(64);
    assert!(
        record::problems(&entry)
            .iter()
            .any(|p| p.contains("prompt_hash"))
    );
    let mut entry = record::record().current;
    entry.url = format!(
        "https://huggingface.co/acme/x/resolve/main/{}",
        entry.file_name
    );
    assert!(
        record::problems(&entry)
            .iter()
            .any(|p| p.contains("pinned to a commit"))
    );
}

#[test]
fn the_escape_breaks_every_special_token_of_every_pinned_model() {
    use centraid_assist::escape::vault_text;
    for (which, entry) in entries() {
        assert!(
            !entry.special_tokens.is_empty(),
            "{which} names no special token"
        );
        for token in &entry.special_tokens {
            let clean = vault_text(&format!("a {token} b"));
            assert!(
                !clean.contains(token.as_str()),
                "{which}: {token:?} survives"
            );
        }
    }
}

#[test]
fn a_release_ships_no_declared_token_list() {
    if std::env::var("CENTRAID_RELEASE_RECORD").as_deref() != Ok("1") {
        return;
    }
    let record = record::record();
    assert_eq!(
        record.current.special_tokens_source, "file",
        "the shipping model's special tokens were declared, not read from its file: run `cargo xtask model-pin`"
    );
}
