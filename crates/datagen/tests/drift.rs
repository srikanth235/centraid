//! `datagen drift`: has the tool contract moved under a data version? Counts on synthetic fixtures, one per level, and
//! the end-to-end report on a version with no sessions, which never opens its test split.

use std::collections::BTreeSet;
use std::path::Path;

use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::gold::Session;
use centraid_datagen::catalog::Catalog;
use centraid_datagen::contract::Contract;
use centraid_datagen::drift::{self, Catalogue, HashDrift, Level, Replayed};
use serde_json::{Value, json};

/// A small catalogue: `find` with free parameters, and `do` with a closed list of verbs (the executed form adds `args` and
/// the selector).
fn catalogue() -> Catalogue {
    let schema = vec![
        json!({"type": "function", "function": {"name": "find", "parameters": {"type": "object",
            "properties": {"kind": {"type": "string"}, "text": {"type": "string"}}, "required": []}}}),
        json!({"type": "function", "function": {"name": "do", "parameters": {"type": "object",
            "properties": {"verb": {"type": "string", "enum": ["archive", "pin"]}, "rows": {"type": "string"}},
            "required": ["verb", "rows"]}}}),
    ];
    Catalogue::from_schema(&["find".to_owned(), "do".to_owned()], &schema)
}

fn session(id: &str, split: &str, calls: &[(&str, Value)]) -> Session {
    serde_json::from_value(json!({
        "id": id, "world": "w", "today": "2026-01-01", "me": "A", "split": split,
        "turns": [{"user": "u", "gold": [],
            "ref": calls.iter().map(|(tool, args)| json!({"tool": tool, "args": args})).collect::<Vec<_>>()}],
    }))
    .expect("session")
}

/// Sessions that show every tool, argument and kind of `catalogue()` once.
fn covering() -> Vec<Session> {
    vec![
        session(
            "train-1",
            "train",
            &[("find", json!({"kind": "note", "text": "x"}))],
        ),
        session(
            "train-2",
            "train",
            &[("do", json!({"verb": "pin", "rows": "#1"}))],
        ),
    ]
}

fn same() -> HashDrift {
    HashDrift {
        tools: ("t".into(), "t".into()),
        prompt: ("p".into(), "p".into()),
        catalog: ("c".into(), "c".into()),
    }
}

fn judge(
    hashes: HashDrift,
    sessions: &[Session],
    replayed: &Replayed,
    kinds: &[&str],
) -> drift::Drift {
    drift::judge("v0.3", hashes, sessions, replayed, &catalogue(), kinds, 1)
}

#[test]
fn nothing_moved_is_level_none() {
    let d = judge(same(), &covering(), &Replayed::default(), &["note"]);
    assert_eq!(d.level, Level::None, "{}", d.text());
    assert!(d.shape.is_empty() && d.behaviour.is_empty() && d.gaps.is_empty());
    assert_eq!((d.sessions, d.calls), (2, 2));
    assert!(d.text().contains("tools_hash: same") && d.text().contains("level: none"));
}

#[test]
fn hashes_that_differ_alone_are_wording() {
    let mut h = same();
    h.tools.1 = "t2".into();
    let d = judge(h, &covering(), &Replayed::default(), &["note"]);
    assert_eq!(d.level, Level::Wording);
    let text = d.text();
    assert!(text.contains("tools_hash: DIFFERENT") && text.contains("prompt_hash: same"));
    assert!(text.contains("re-render from the cache"));
}

#[test]
fn calls_that_no_longer_validate_are_shape_by_tool_and_argument() {
    let mut sessions = covering();
    sessions.push(session(
        "train-3",
        "train",
        &[
            ("find", json!({"kind": "note", "order": "newest"})),
            ("tag", json!({"rows": "#1"})),
            ("do", json!({"verb": "tag", "rows": "#1"})),
            // the executed form: `args` lines and a selector are the runtime's, not a shape finding
            (
                "do",
                json!({"verb": "pin", "kind": "note", "name": "x", "args": "to: 2026-01-01"}),
            ),
        ],
    ));
    let d = judge(same(), &sessions, &Replayed::default(), &["note"]);
    assert_eq!(d.level, Level::Shape);
    let counts: Vec<(String, String, usize)> = d
        .shape
        .iter()
        .map(|(k, n)| (k.tool.clone(), k.what.clone(), *n))
        .collect();
    assert_eq!(
        counts,
        [
            ("do", "`verb` no longer takes `tag`", 1),
            ("find", "argument `order` is gone", 1),
            ("tag", "the tool is gone", 1),
        ]
        .map(|(a, b, n)| (a.to_owned(), b.to_owned(), n))
    );
    assert_eq!(d.shape_turns, 1);
    assert!(
        d.text()
            .contains("find: argument `order` is gone (1 call(s))")
    );
}

#[test]
fn calls_that_validate_but_give_another_result_are_behaviour_and_not_counted_twice() {
    let mut sessions = covering();
    sessions.push(session(
        "train-3",
        "train",
        &[("find", json!({"kind": "note", "gone": "1"}))],
    ));
    let replayed = Replayed {
        sessions: 3,
        turns: 3,
        failed: vec![
            ("train-1".into(), 1), // validates: behaviour
            ("train-3".into(), 1), // does not validate: shape's, not behaviour's
        ],
        refused: vec![],
        unrunnable: vec![],
    };
    let d = judge(same(), &sessions, &replayed, &["note"]);
    assert_eq!(d.level, Level::Shape.max(Level::Behaviour));
    assert_eq!(d.behaviour_turns, 1);
    assert_eq!(d.behaviour.get("find"), Some(&1));
    assert_eq!(d.shape_turns, 1);
    // alone, it is behaviour; a world that no longer seeds is behaviour too
    let d = judge(
        same(),
        &covering(),
        &Replayed {
            failed: vec![("train-2".into(), 1)],
            ..Replayed::default()
        },
        &["note"],
    );
    assert_eq!(d.level, Level::Behaviour);
    assert_eq!(d.behaviour.get("do"), Some(&1));
    let d = judge(
        same(),
        &covering(),
        &Replayed {
            unrunnable: vec!["train-1".into()],
            ..Replayed::default()
        },
        &["note"],
    );
    assert_eq!(d.level, Level::Behaviour);
}

#[test]
fn tools_arguments_and_kinds_the_data_hardly_shows_are_coverage() {
    // only `find` is shown: `do` and its arguments, and the kind `event`, have no example
    let sessions = vec![session(
        "train-1",
        "train",
        &[("find", json!({"kind": "note"}))],
    )];
    let d = judge(same(), &sessions, &Replayed::default(), &["note", "event"]);
    assert_eq!(d.level, Level::Coverage);
    let gaps: BTreeSet<String> = d
        .gaps
        .iter()
        .map(|g| format!("{} {} {}", g.of, g.name, g.examples))
        .collect();
    for want in [
        "tool do 0",
        "argument do.verb 0",
        "argument do.rows 0",
        "argument find.text 0",
        "kind event 0",
    ] {
        assert!(gaps.contains(want), "{want} not in {gaps:?}");
    }
    assert!(
        !gaps
            .iter()
            .any(|g| g.starts_with("tool find") || g.contains("kind note"))
    );
    // under the floor counts too, and val sessions do not count toward train's coverage
    let two = drift::coverage(&covering(), &catalogue(), &["note"], 2);
    assert!(two.iter().any(|g| g.name == "find" && g.examples == 1));
    let val_only = vec![session(
        "val-1",
        "val",
        &[("find", json!({"kind": "note"}))],
    )];
    let d = judge(same(), &val_only, &Replayed::default(), &["note"]);
    assert!(d.gaps.iter().any(|g| g.of == "tool" && g.name == "find"));
}

#[test]
fn the_level_is_the_most_work_any_finding_calls_for() {
    let mut h = same();
    h.catalog.1 = "c2".into();
    let mut sessions = covering();
    sessions.push(session(
        "train-3",
        "train",
        &[("find", json!({"order": "x"}))],
    ));
    let d = judge(h, &sessions, &Replayed::default(), &["note", "event"]);
    assert_eq!(d.level, Level::Coverage);
    assert!(
        Level::Wording < Level::Shape
            && Level::Shape < Level::Behaviour
            && Level::Behaviour < Level::Coverage
    );
    let text = d.text();
    assert!(text.contains("level: coverage") && text.contains("\"level\": \"coverage\""));
}

fn zst(lines: &[&str]) -> Vec<u8> {
    zstd::encode_all((lines.join("\n") + "\n").as_bytes(), 3).expect("zstd")
}

fn version(dir: &Path, tools_hash_wrong: bool) {
    let mut contract = Contract::current(
        ToolsMode::Sig,
        &Catalog::build().expect("catalog").hash(),
        "ab12",
    );
    if tools_hash_wrong {
        contract.tools_hash = "0".repeat(64);
    }
    std::fs::create_dir_all(dir.join("data")).expect("mkdir");
    for split in ["train", "val"] {
        std::fs::write(dir.join(format!("data/{split}.jsonl.zst")), zst(&[])).expect("write");
    }
    // the test split is garbage that is not zstd: drift must not open it
    std::fs::write(dir.join("data/test.jsonl.zst"), b"not zstd").expect("write");
    std::fs::write(
        dir.join("manifest.json"),
        json!({"version": "v9", "contract": contract.to_json(), "targets": {"cell_floor": {"train": 1}}}).to_string(),
    )
    .expect("manifest");
}

#[test]
fn the_report_on_a_version_reads_train_and_val_only_and_compares_the_contract() {
    let dir = tempfile::tempdir().expect("dir");
    version(dir.path(), false);
    let d = drift::report(dir.path()).expect("reports");
    assert!(d.hashes.same(), "{}", d.text());
    assert_eq!(d.sessions, 0);
    // nothing is shown, so every tool of the catalogue is a gap
    assert_eq!(d.level, Level::Coverage);
    assert!(d.gaps.iter().any(|g| g.of == "tool" && g.name == "find"));
    let dir = tempfile::tempdir().expect("dir");
    version(dir.path(), true);
    let d = drift::report(dir.path()).expect("reports");
    assert!(!d.hashes.same() && d.text().contains("tools_hash: DIFFERENT"));
    // no contract block: refused, pointing at restamp
    std::fs::write(
        dir.path().join("manifest.json"),
        json!({"version": "v9"}).to_string(),
    )
    .expect("w");
    let why = drift::report(dir.path()).expect_err("refused").to_string();
    assert!(why.contains("restamp"), "{why}");
}

#[test]
fn a_turn_the_runtime_refused_is_a_shape_finding_by_the_tools_of_the_turn() {
    let replayed = Replayed {
        refused: vec![("train-2".into(), 1)],
        ..Replayed::default()
    };
    let d = judge(same(), &covering(), &replayed, &["note"]);
    assert_eq!(d.level, Level::Shape);
    assert_eq!(d.behaviour_turns, 0);
    assert_eq!(d.shape_turns, 1);
    assert!(
        d.text()
            .contains("do: the runtime refused the turn's calls (1 call(s))")
    );
}

/// Calls as the data records them in sig mode: the executed form, `create` and `edit` with their fields as `args` lines.
fn sig_sessions() -> Vec<Session> {
    let verb = centraid_assist::native::prompt::tools()
        .iter()
        .find(|t| t["function"]["name"] == "do")
        .and_then(|t| {
            t["function"]["parameters"]["properties"]["verb"]["enum"][0]
                .as_str()
                .map(str::to_owned)
        })
        .expect("a verb");
    vec![
        session(
            "train-1",
            "train",
            &[
                (
                    "create",
                    json!({"kind": "note", "args": "name: Pay rent\nbody: soon", "more": "false"}),
                ),
                ("edit", json!({"rows": "#1", "args": "name: Pay the rent"})),
            ],
        ),
        session(
            "train-2",
            "train",
            &[("find", json!({"kind": "note", "text": "rent"}))],
        ),
        session(
            "train-3",
            "train",
            &[(
                "do",
                json!({"verb": verb, "kind": "note", "name": "Pay rent", "args": ""}),
            )],
        ),
    ]
}

#[test]
fn the_sig_modes_own_calls_are_not_a_shape_finding_and_fields_are_counted_from_inside_args() {
    let sig = Catalogue::of_mode(ToolsMode::Sig).expect("sig");
    // the runtime's real tools: the executed form of create, edit and do fits them
    let none = drift::judge(
        "v0.3",
        same(),
        &sig_sessions(),
        &Replayed::default(),
        &sig,
        &[],
        0,
    );
    assert!(none.shape.is_empty(), "{}", none.text());
    assert_eq!(none.level, Level::None, "{}", none.text());
    assert!(!none.text().contains("SELF-CHECK") && none.notes.is_empty());
    // with a floor, create's `name` and `body` count from inside `args`; a field no call writes is the gap
    let some = drift::judge(
        "v0.3",
        same(),
        &sig_sessions(),
        &Replayed::default(),
        &sig,
        &[],
        1,
    );
    let gaps: BTreeSet<String> = some
        .gaps
        .iter()
        .map(|g| format!("{} {}", g.of, g.name))
        .collect();
    assert!(
        !gaps.contains("argument create.name") && !gaps.contains("argument create.body"),
        "{gaps:?}"
    );
    assert!(
        !gaps.contains("argument edit.name") && !gaps.contains("argument find.text"),
        "{gaps:?}"
    );
    assert!(gaps.contains("argument edit.body"), "{gaps:?}");
    assert!(!gaps.contains("tool create") && !gaps.contains("tool do"));
    assert!(gaps.contains("tool compute"));
}

#[test]
fn a_call_to_a_tool_the_sig_catalogue_does_not_have_is_a_shape_finding_and_s2_is_refused() {
    let sig = Catalogue::of_mode(ToolsMode::Sig).expect("sig");
    // the s2 tools (`search`, `open`, `act`) are not the sig tools
    let old = vec![session(
        "train-1",
        "train",
        &[
            ("act", json!({"verb": "pin", "rows": "#1"})),
            ("find", json!({"kind": "note", "where_clause": "x"})),
        ],
    )];
    let d = drift::judge("v0.3", same(), &old, &Replayed::default(), &sig, &[], 0);
    assert_eq!(d.level, Level::Shape);
    let found: Vec<(String, String)> = d
        .shape
        .keys()
        .map(|k| (k.tool.clone(), k.what.clone()))
        .collect();
    assert_eq!(
        found,
        [
            ("act", "the tool is gone"),
            ("find", "argument `where_clause` is gone")
        ]
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
    );
    let why = Catalogue::of_mode(ToolsMode::S2)
        .expect_err("refused")
        .to_string();
    assert!(why.contains("s2") && why.contains("frozen"), "{why}");
}

#[test]
fn a_publish_refuses_coverage_above_zero_and_any_shape_or_behaviour_count_and_says_the_counts() {
    // nothing moved, or the hashes alone: nothing to refuse
    let d = judge(same(), &covering(), &Replayed::default(), &["note"]);
    assert!(d.refusals().is_empty());
    let mut h = same();
    h.tools.1 = "t2".into();
    assert!(
        judge(h, &covering(), &Replayed::default(), &["note"])
            .refusals()
            .is_empty(),
        "a difference of wording is re-rendered from the cache, not refused"
    );
    // coverage: a kind the data never shows
    let d = judge(
        same(),
        &covering(),
        &Replayed::default(),
        &["note", "photo"],
    );
    let why = d.refusals();
    assert_eq!(why.len(), 1, "{why:?}");
    assert!(
        why[0].contains("coverage 1: 1 item(s)") && why[0].contains("kind photo: 0"),
        "{why:?}"
    );
    // shape: a call that no longer validates
    let mut sessions = covering();
    sessions.push(session(
        "train-3",
        "train",
        &[("find", json!({"kind": "note", "order": "newest"}))],
    ));
    let why = judge(same(), &sessions, &Replayed::default(), &["note"]).refusals();
    assert_eq!(why.len(), 1, "{why:?}");
    assert!(
        why[0].contains("shape 1: 1 call kind(s) no longer validate, in 1 turn(s)"),
        "{why:?}"
    );
    // behaviour: a turn that runs and gives another result, and a session that cannot run
    let replayed = Replayed {
        sessions: 2,
        turns: 2,
        failed: vec![("train-1".to_owned(), 1)],
        unrunnable: vec!["train-2".to_owned()],
        ..Replayed::default()
    };
    let why = judge(same(), &covering(), &replayed, &["note"]).refusals();
    assert_eq!(why.len(), 1, "{why:?}");
    assert!(
        why[0].contains("behaviour 2: 1 turn(s) run but do not give the recorded result; 1 session(s) could not run"),
        "{why:?}"
    );
    // all three at once are three refusals
    let mut all = sessions;
    all.extend(covering());
    assert_eq!(
        judge(same(), &all, &replayed, &["note", "photo"])
            .refusals()
            .len(),
        3
    );
}
