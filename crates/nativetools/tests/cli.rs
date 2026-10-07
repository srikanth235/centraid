//! The CLI round trip the Python side drives: export, seed, copy, session.

use std::io::Write as _;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_nativetools");

#[test]
fn export_writes_every_contract_file() {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new(BIN)
        .args(["export"])
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    for file in [
        "tools.json",
        "tools.full.json",
        "date_expr.schema.json",
        "phrases.json",
        "metadata.json",
    ] {
        let text = std::fs::read_to_string(dir.path().join(file)).unwrap();
        serde_json::from_str::<Value>(&text).unwrap_or_else(|error| panic!("{file}: {error}"));
    }
    for file in [
        "kind_card.txt",
        "prompt.sig.txt",
        "prompt.compact.txt",
        "prompt.full.txt",
    ] {
        assert!(
            !std::fs::read_to_string(dir.path().join(file))
                .unwrap()
                .is_empty(),
            "{file}"
        );
    }
    let phrases: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("phrases.json")).unwrap())
            .unwrap();
    assert!(phrases.as_array().unwrap().len() >= 60);
}

#[test]
fn seed_copy_and_a_json_lines_session_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let world = dir.path().join("world.json");
    std::fs::write(&world, include_str!("fixtures/world.json")).unwrap();
    let vault = dir.path().join("vault.db");
    let seeded = Command::new(BIN)
        .arg("seed")
        .arg(&world)
        .arg(&vault)
        .output()
        .unwrap();
    assert!(
        seeded.status.success(),
        "{}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    let keys: Value = serde_json::from_slice(&seeded.stdout).unwrap();
    let cabin = keys["keys"]["cabin"]["id"].as_str().unwrap().to_owned();
    let copy = dir.path().join("copy.db");
    let copied = Command::new(BIN)
        .arg("copy")
        .arg(&vault)
        .arg(&copy)
        .output()
        .unwrap();
    assert!(
        copied.status.success(),
        "{}",
        String::from_utf8_lossy(&copied.stderr)
    );

    let mut child = Command::new(BIN)
        .arg("session")
        .arg(&copy)
        .args(["--today", "2026-09-27", "--me", "Sam Park"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let raw = "<think>\nintent: write complete\n</think>\n<tool_call>\n<function=act>\n<parameter=verb>\ncomplete\n</parameter>\n<parameter=kind>\ntask\n</parameter>\n<parameter=name>\ncabin\n</parameter>\n</function>\n</tool_call>";
    let requests = [
        json!({"op": "prompt"}),
        json!({"op": "user", "text": "is the cabin booked?"}),
        json!({"op": "call", "tool": "find", "args": {"kind": "task", "name": "cabin"}}),
        json!({"op": "parse", "text": raw}),
        json!({"op": "call_text", "text": raw}),
        json!({"op": "user", "text": "hm"}),
        json!({"op": "call_text", "text": "I think it is done."}),
        json!({"op": "nope"}),
    ];
    {
        let stdin = child.stdin.as_mut().unwrap();
        for request in &requests {
            writeln!(stdin, "{request}").unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), requests.len());
    assert!(
        lines[0]["system"]
            .as_str()
            .unwrap()
            .starts_with("today: Sunday 2026-09-27\nme: Sam Park")
    );
    assert!(
        lines[0]["rendered"]
            .as_str()
            .unwrap()
            .starts_with("<|im_start|>system\n# Tools")
    );
    assert_eq!(lines[1]["turn"], 1);
    assert_eq!(lines[1]["preground"], "vault: #9 task \"Book the cabin\"");
    assert_eq!(lines[2]["ends_turn"], false);
    assert_eq!(
        lines[3],
        json!({"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "cabin"}})
    );
    assert_eq!(lines[4]["ends_turn"], true);
    assert_eq!(lines[4]["effect"]["diff"]["rows"][0]["id"], cabin);
    assert_eq!(
        lines[4]["effect"]["diff"]["rows"][0]["fields"]["status"],
        json!(["open", "completed"])
    );
    assert!(
        lines[6]["text"]
            .as_str()
            .unwrap()
            .starts_with("error: could not read the call (no <tool_call>). tools: search, find")
    );
    assert_eq!(lines[6]["step"], 1);
    assert!(lines[7]["error"].as_str().unwrap().contains("unknown op"));
}

#[test]
fn the_tools_flag_picks_the_spelling_and_rejects_an_unknown_one() {
    let dir = tempfile::tempdir().unwrap();
    let world = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/world.json");
    let vault = dir.path().join("vault.db");
    let seeded = Command::new(BIN)
        .arg("seed")
        .arg(world)
        .arg(&vault)
        .output()
        .unwrap();
    assert!(seeded.status.success());
    let prompt = |mode: Option<&str>| {
        let mut command = Command::new(BIN);
        command
            .arg("session")
            .arg(&vault)
            .args(["--today", "2026-09-27"]);
        if let Some(mode) = mode {
            command.args(["--tools", mode]);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // A rejected flag exits before reading stdin, so the write may
        // meet a closed pipe; the exit status is what the test reads.
        let _ = writeln!(child.stdin.as_mut().unwrap(), "{}", json!({"op": "prompt"}));
        child.wait_with_output().unwrap()
    };
    let read =
        |out: std::process::Output| -> Value { serde_json::from_slice(&out.stdout).unwrap() };
    let default = read(prompt(None));
    let compact = read(prompt(Some("compact")));
    let sig = read(prompt(Some("sig")));
    let full = read(prompt(Some("full")));
    assert_eq!(default["rendered"], sig["rendered"], "sig is the default");
    let length = |value: &Value| value["rendered"].as_str().unwrap().len();
    assert!(length(&sig) < length(&compact) && length(&compact) < length(&full));
    assert!(
        sig["rendered"]
            .as_str()
            .unwrap()
            .contains("\"description\": \"find(kind, name?, where?, when?,")
    );
    assert_eq!(sig["system"], compact["system"]);
    let bad = prompt(Some("tiny"));
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("--tools takes sig, compact or full"));
}

#[test]
fn the_no_compose_flag_restores_the_old_replies() {
    let dir = tempfile::tempdir().unwrap();
    let world = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/world.json");
    let vault = dir.path().join("vault.db");
    let seeded = Command::new(BIN)
        .arg("seed")
        .arg(world)
        .arg(&vault)
        .output()
        .unwrap();
    assert!(seeded.status.success());
    let reply = |flags: &[&str]| -> Value {
        let mut child = Command::new(BIN)
            .arg("session")
            .arg(&vault)
            .args(["--today", "2026-09-27"])
            .args(flags)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let requests = [
            json!({"op": "user", "text": "log a call with neha"}),
            json!({"op": "call", "tool": "act", "args": {"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}}),
        ];
        for request in &requests {
            writeln!(child.stdin.as_mut().unwrap(), "{request}").unwrap();
        }
        let output = child.wait_with_output().unwrap();
        let line = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .last()
            .unwrap()
            .to_owned();
        serde_json::from_str(&line).unwrap()
    };
    let composed = reply(&[]);
    assert_eq!(composed["ends_turn"], true, "{composed}");
    assert_eq!(composed["effect"]["tool"], "ask", "{composed}");
    assert_eq!(composed["effect"]["composed"], true, "{composed}");
    let old = reply(&["--no-compose"]);
    assert_eq!(old["ends_turn"], false, "{old}");
    assert!(
        old["text"]
            .as_str()
            .unwrap()
            .starts_with("ambiguous: \"Neha\" fits"),
        "{old}"
    );
}
