//! The stateless compiler (`think.rs`) over the golden file of the trace contract (`CONTRACT_V3.md`): one think and its call for
//! every distinct call shape of the train data (`authored/golden_v3.json`, 871 shapes, 69 with a `dates:` line).
//!
//! The same file is what `authored/test_trace.py` and `train/test_trace3.py` read through the Python client, and
//! `authored/compile_oracle.py` runs every think of the train data through the compiler and compares two runs.

use centraid_nativetools::compile::CALL_ORDER;
use centraid_nativetools::think::{Call, TraceMode, compile_think, v4_think};
use serde_json::Value;

fn golden() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../experiments/toolchat/native/authored/golden_v3.json"
    ))
    .expect("authored/golden_v3.json");
    serde_json::from_str(&text).expect("the golden file is JSON")
}

/// The call of a golden row, its arguments in the order a call writes them.
fn want(row: &Value) -> Call {
    let args = row["call"]["args"].as_object().expect("args");
    Call {
        tool: row["call"]["tool"].as_str().expect("tool").to_owned(),
        args: CALL_ORDER
            .iter()
            .filter_map(|key| {
                args.get(*key)
                    .map(|value| ((*key).to_owned(), value.as_str().expect("text").to_owned()))
            })
            .collect(),
    }
}

fn dates(row: &Value) -> Option<&str> {
    row["dates"].as_str()
}

#[test]
fn every_golden_shape_compiles_to_its_call() {
    let rows = golden();
    assert!(rows.len() > 800, "{}", rows.len());
    for row in &rows {
        let think = row["think"].as_str().expect("think");
        let got = compile_think(think, dates(row), TraceMode::V31)
            .unwrap_or_else(|refusal| panic!("{}: {refusal:?}", row["shape"]));
        assert_eq!(got, want(row), "{}", row["shape"]);
    }
}

#[test]
fn every_golden_v4_think_compiles_to_the_same_call() {
    let mut said = 0;
    for row in golden() {
        let Some(think4) = row["think4"].as_str() else {
            // v4 has no lookup step: `find`
            assert_eq!(row["call"]["tool"], "find", "{}", row["shape"]);
            continue;
        };
        said += 1;
        let got = compile_think(think4, dates(&row), TraceMode::V4)
            .unwrap_or_else(|refusal| panic!("{}: {refusal:?}", row["shape"]));
        assert_eq!(got, want(&row), "{}", row["shape"]);
    }
    assert!(said > 500, "{said}");
}

#[test]
fn every_golden_v31_think_rewrites_to_its_v4_think() {
    for row in golden() {
        let think = row["think"].as_str().expect("think");
        match (v4_think(think, dates(&row), None), row["think4"].as_str()) {
            (Ok(rewritten), Some(think4)) => assert_eq!(rewritten, think4, "{}", row["shape"]),
            (Err(skip), None) => assert_eq!(skip.reason, "find", "{}", row["shape"]),
            (got, think4) => panic!("{}: {got:?} against {think4:?}", row["shape"]),
        }
    }
}

#[test]
fn a_v4_think_is_its_own_rewrite() {
    let think = "intent: write\nverb: complete\npick: #31 (name)\nwithin: @1";
    assert_eq!(v4_think(think, None, None).unwrap(), think);
    assert_eq!(
        v4_think(&format!("\n{think}  \n"), None, None).unwrap(),
        think
    );
}

#[test]
fn a_think_is_read_in_the_mode_only_when_it_holds_no_construct_of_either_version() {
    // no `scope`, `refer`, `target`, candidate pick or one-row pick: the mode decides what the compiler infers
    let think = "intent: write\nverb: complete\nname: Pay rent";
    let kind = |mode| {
        let call = compile_think(think, None, mode).unwrap();
        call.args.iter().any(|(key, _)| key == "kind")
    };
    assert!(kind(TraceMode::V4));
    assert!(!kind(TraceMode::V31));
    // a v3.1 construct wins over the mode
    let think = "intent: write\nverb: complete\nscope: one\nname: Pay rent";
    assert!(
        !compile_think(think, None, TraceMode::V4)
            .unwrap()
            .args
            .iter()
            .any(|(key, _)| key == "kind")
    );
    // and a one-row pick is v4 whatever the mode
    let think = "intent: write\nverb: star\npick: #5 (name)";
    assert_eq!(
        compile_think(think, None, TraceMode::V31).unwrap().args,
        [
            ("verb".to_owned(), "star".to_owned()),
            ("rows".to_owned(), "#5".to_owned())
        ]
    );
}
