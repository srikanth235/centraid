//! ROLLOUTS WITH NO MODEL: a scripted model plays several samples of a small session through the real runtime; the
//! report and the RFT records are checked on what it said. No weights, no network, no clocks.

use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::gold::Session;
use centraid_assist_eval::rollout::fake::{Scripted, message};
use centraid_assist_eval::rollout::records::{self, Needs, RecordStats, Weighing};
use centraid_assist_eval::rollout::report::{self, RolloutReport};
use centraid_assist_eval::rollout::{Rollout, run_rollouts};
use centraid_assist_eval::run::Runner;
use centraid_assist_eval::source::MemorySource;
use serde_json::{Value, json};

fn world() -> Value {
    json!({
        "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "rollout",
        "people": [{"key": "neha", "name": "Neha Rao"}, {"key": "ravi", "name": "Ravi Menon"}]
    })
}

fn session() -> Session {
    serde_json::from_value(json!({
        "id": "S", "world": "W", "today": "2026-03-12T18:20", "me": "Sam Park", "tags": ["pair:p1"],
        "turns": [
            {"user": "write me a poem", "gold": [{"type": "decline", "reasons": ["out_of_scope"]}],
             "ref": [{"tool": "decline", "args": {"reason": "out_of_scope"}}], "tags": ["outcome:decline"]},
            {"user": "who is neha", "gold": [{"type": "rows", "rows": ["neha"]}],
             "ref": [{"tool": "find", "args": {"kind": "person", "name": "neha"}},
                     {"tool": "answer", "args": {"rows": "@1"}}], "tags": ["reference:name"]}
        ]
    }))
    .expect("session")
}

fn source() -> MemorySource {
    MemorySource {
        label: "rollout".to_owned(),
        sessions: vec![session()],
        worlds: [("W".to_owned(), world())].into_iter().collect(),
    }
}

fn decline() -> String {
    message("decline", &[("reason", "out_of_scope")])
}

fn find(name: &str) -> String {
    message("find", &[("kind", "person"), ("name", name)])
}

fn answer() -> String {
    message("answer", &[("rows", "@1")])
}

/// Four samples: right, wrong person, right again (the same messages as the first), and a decline on turn two.
fn sampled() -> Vec<Rollout> {
    let script = Scripted::new(vec![
        decline(),
        find("Neha"),
        answer(),
        decline(),
        find("Ravi"),
        answer(),
        decline(),
        find("Neha"),
        answer(),
        decline(),
        decline(),
    ]);
    let source = source();
    let mut runner = Runner::new(&source, &script)
        .expect("runner")
        .with_tools(ToolsMode::Sig);
    run_rollouts(&mut runner, &source.sessions[0], 4).expect("rollouts")
}

#[test]
fn samples_are_judged_by_effect_and_keep_what_the_model_said() {
    let rollouts = sampled();
    let pass: Vec<bool> = rollouts.iter().map(|r| r.result.pass()).collect();
    assert_eq!(pass, [true, false, true, false]);
    assert_eq!(rollouts[1].first_failure(), Some(1));
    assert_eq!(rollouts[1].clean(), 2);
    let turn = &rollouts[0].result.turns[1];
    assert_eq!(turn.cell, "answer/person");
    assert_eq!(turn.said.len(), 2);
    assert_eq!(rollouts[1].result.turns[1].args["rows"], "wrong");
}

#[test]
fn the_report_gives_a_rate_per_cell_and_survives_json() {
    let rollouts = sampled();
    let report = report::build("fake", "set", None, &rollouts);
    assert_eq!((report.sessions, report.rollouts), (1, 4));
    assert_eq!((report.session_pass.k, report.session_pass.n), (2, 4));
    assert_eq!(
        (report.session_pass_at_k.k, report.session_pass_at_k.n),
        (1, 1)
    );
    let cell = report.by_cell["answer/person"];
    assert_eq!((cell.rate.k, cell.rate.n), (2, 4));
    assert_eq!((cell.turns, cell.solved, cell.mixed), (1, 1, 1));
    let decline = report.by_cell["decline"];
    assert_eq!((decline.rate.k, decline.rate.n), (4, 4));
    assert_eq!((decline.solved, decline.mixed), (1, 0));
    assert_eq!(
        (
            report.by_tag["reference:name"].rate.k,
            report.by_tag["pair:p1"].rate.n
        ),
        (2, 8)
    );
    let rows = report.arguments["rows"];
    assert_eq!((rows.right, rows.scored), (2, 4));
    let back: RolloutReport =
        serde_json::from_str(&serde_json::to_string(&report).unwrap()).unwrap();
    assert_eq!(back.by_cell["answer/person"].rate.k, 2);
}

#[test]
fn comparing_two_reports_shows_the_change_per_cell() {
    let before = report::build("round 1", "set", None, &sampled());
    // the second round: the same session, every sample right
    let script = Scripted::new(
        std::iter::repeat_n([decline(), find("Neha"), answer()], 4)
            .flatten()
            .collect(),
    );
    let source = source();
    let mut runner = Runner::new(&source, &script)
        .unwrap()
        .with_tools(ToolsMode::Sig);
    let better = run_rollouts(&mut runner, &source.sessions[0], 4).unwrap();
    let after = report::build("round 2", "set", None, &better);
    let comparison = report::compare(&before, &after);
    let cell = comparison.by_cell["answer/person"];
    assert_eq!(cell.points, Some(50.0));
    assert!(!cell.clear, "four samples cannot make a clear change");
    assert_eq!(comparison.overall["session_pass"].points, Some(50.0));
    assert_eq!(comparison.by_constraints["1"].before.map(|r| r.k), Some(2));
    let text = report::compare_text(&comparison);
    assert!(
        text.contains("answer/person") && text.contains("+50.0 pts"),
        "{text}"
    );
}

#[test]
fn rft_keeps_passing_prefixes_once_and_weighs_toward_what_fails() {
    let rollouts = sampled();
    let sessions = [session()];
    // with no needs: samples 0 and 2 are the same messages (one record), 1 and 3 keep their passing first turn,
    // which repeats too
    let mut stats = RecordStats::default();
    let plain = records::rft_records(
        &sessions,
        &rollouts,
        &Needs::default(),
        Weighing::default(),
        &mut stats,
    );
    assert_eq!(plain.len(), 2);
    assert_eq!(stats.rft_duplicates, 2);
    assert!(
        plain
            .iter()
            .all(|r| (r.weight - 1.0).abs() < f64::EPSILON && r.copies == 1)
    );
    assert_eq!(plain[0].record.turns.len(), 2);
    assert_eq!(plain[0].record.turns[1].reference[0].tool, "find");
    assert_eq!(plain[1].record.turns.len(), 1);
    // the model fails half of the answer/person cell and its rows argument: the record that reaches it counts more
    let needs = Needs::from_report(
        &serde_json::to_value(report::build("fake", "set", None, &rollouts)).unwrap(),
        1,
    );
    assert!((needs.cells["answer/person"] - 0.5).abs() < 1e-9);
    let mut stats = RecordStats::default();
    let weighed = records::rft_records(
        &sessions,
        &rollouts,
        &needs,
        Weighing::default(),
        &mut stats,
    );
    assert!(
        weighed[0].weight > 2.0 && weighed[0].copies >= 2,
        "{}",
        weighed[0].weight
    );
    assert_eq!(weighed.len(), stats.rft_lines);
    assert!(
        weighed
            .iter()
            .filter(|r| r.record.id.starts_with("S~s0"))
            .count()
            >= 2
    );
    // the record that stops at the passed decline weighs no more than the one that reaches the failing cell
    assert!(weighed.last().unwrap().weight <= weighed[0].weight);
}

#[test]
fn a_renderer_fills_the_render_of_every_record() {
    struct Count;
    impl records::RenderRecord for Count {
        fn render(&self, record: &records::Record) -> Result<records::Rendered, String> {
            Ok(records::Rendered {
                input_ids: vec![record.turns.len() as u32],
                weights: vec![1.0],
                text: record.id.clone(),
            })
        }
    }
    let rollouts = sampled();
    let mut stats = RecordStats::default();
    let mut rft = records::rft_records(
        &[session()],
        &rollouts,
        &Needs::default(),
        Weighing::default(),
        &mut stats,
    );
    assert!(
        serde_json::to_value(&rft[0])
            .unwrap()
            .get("render")
            .is_none()
    );
    records::render_all(&Count, &mut rft).unwrap();
    assert_eq!(
        serde_json::to_value(&rft[0]).unwrap()["render"]["input_ids"],
        json!([2])
    );
    assert_eq!(
        serde_json::to_value(&rft[0]).unwrap()["render"]["weights"],
        json!([1.0])
    );
}

/// Records are cut from the train split only: val, test and noise are refused, before anything is written.
#[test]
fn records_are_never_cut_from_a_held_out_split() {
    let rollouts = sampled();
    let needs = Needs::default();
    for (split, refused) in [
        (Some("val"), true),
        (Some("test"), true),
        (Some("noise"), true),
        (Some("train"), false),
        (None, false),
    ] {
        let mut held = session();
        held.split = split.map(str::to_owned);
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("records");
        let result = records::cut(
            &[held],
            &rollouts,
            &records::Cutting {
                needs: &needs,
                weighing: Weighing::default(),
            },
            None,
            &out,
        );
        match (refused, result) {
            (true, Err(error)) => {
                let text = error.to_string();
                assert!(
                    text.contains("held-out") && text.contains(split.unwrap()),
                    "{text}"
                );
                assert!(!out.exists(), "nothing is written for {split:?}");
            }
            (false, Ok(_)) => assert!(out.join("rft.jsonl").exists()),
            (refused, other) => panic!("{split:?}: refused={refused}, got {other:?}"),
        }
    }
}
