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
