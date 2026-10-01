//! Crate tests.

use crate::{canon, map};

/// **THE ROUND TRIP.** Every canonical in `map.json` parses, and the tree it
/// parses to re-serializes to a string that parses to the same tree.
#[test]
fn every_canonical_round_trips() {
    let turns = map::read_all(&map::default_path()).expect("map.json reads");
    let mut parsed = 0usize;
    let mut failures = Vec::new();
    for turn in &turns {
        if !turn.covered {
            continue;
        }
        let tree = match canon::parse(&turn.canonical) {
            Ok(tree) => tree,
            Err(complaint) => {
                failures.push(format!(
                    "{}/{}.{}: does not parse: {complaint}\n    {}",
                    turn.corpus, turn.session, turn.turn, turn.canonical
                ));
                continue;
            }
        };
        let printed = tree.to_canonical();
        match canon::parse(&printed) {
            Ok(again) if again == tree => parsed += 1,
            Ok(_) => failures.push(format!(
                "{}/{}.{}: parse(serialize(t)) != t\n    {printed}",
                turn.corpus, turn.session, turn.turn
            )),
            Err(complaint) => failures.push(format!(
                "{}/{}.{}: serialize does not re-parse: {complaint}\n    {printed}",
                turn.corpus, turn.session, turn.turn
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(parsed >= 434, "only {parsed} canonicals round-tripped");
}

// ---------------------------------------------------------------------------
// THE RATCHET
//
// Each of these asserts the oracle's pass rate on one corpus is at least what
// it was when the executor landed. They are SLOW — each deals one private
// world per session and runs the whole corpus — and they are the reason a
// later change to `exec.rs` cannot quietly cost a session.
//
// A number here is a CEILING (the oracle is handed the gold canonical), never
// a candidate's score. Raising one is the point; lowering one is a regression
// and must be argued for in the PR, not edited away.
// ---------------------------------------------------------------------------

fn passed(corpus: &str) -> (usize, usize) {
    let report = crate::oracle_report(corpus).expect("the corpus runs");
    report.strict_sessions()
}

#[test]
fn the_oracle_holds_its_ground_on_the_suite() {
    let (passed, total) = passed("suite");
    assert_eq!(total, 120, "the suite changed size");
    assert!(passed >= 120, "suite: {passed}/{total}, the ratchet is 120");
}

#[test]
fn the_oracle_holds_its_ground_on_the_blind_set() {
    let (passed, total) = passed("blind");
    assert_eq!(total, 60, "the blind set changed size");
    assert!(passed >= 60, "blind: {passed}/{total}, the ratchet is 60");
}

#[test]
fn the_oracle_holds_its_ground_on_the_holdout() {
    let (passed, total) = passed("holdout");
    assert_eq!(total, 78, "the holdout changed size");
    assert!(passed >= 78, "holdout: {passed}/{total}, the ratchet is 78");
}

// ---------------------------------------------------------------------------
// RELATIVE DATES (GRAMMAR.md §1.3) — parse, round trip, resolution
// ---------------------------------------------------------------------------

/// 2026-06-15 is a Monday.
const REL_TODAY: &str = "2026-06-15";

fn resolved_arg(canonical: &str) -> canon::Lit {
    let tree = canon::parse_for_execution(canonical, REL_TODAY).expect("resolves");
    let canon::Turn::Cmd(cmd) = tree else {
        panic!("not a command: {canonical}")
    };
    match &cmd.args[0].1 {
        canon::ArgVal::Lit(lit) => lit.clone(),
        other => panic!("not a literal: {other:?}"),
    }
}

#[test]
fn relative_days_resolve_by_the_spec_rules() {
    for (phrase, want) in [
        ("friday", "2026-06-19"),
        ("monday", "2026-06-22"), // today's own weekday is a week ahead
        ("next friday", "2026-06-26"),
        ("next monday", "2026-06-22"),
        ("last friday", "2026-06-12"),
        ("last monday", "2026-06-08"),
        ("today", "2026-06-15"),
        ("tomorrow", "2026-06-16"),
        ("yesterday", "2026-06-14"),
        ("the 21st", "2026-06-21"),
        ("the 15th", "2026-06-15"),
        ("the 3rd", "2026-07-03"),
        ("in 3 days", "2026-06-18"),
        ("in 0 days", "2026-06-15"),
    ] {
        let lit = resolved_arg(&format!("reschedule{{to: {phrase}}} on (it)"));
        assert_eq!(
            (lit.ty.as_str(), lit.value.as_str()),
            ("date", want),
            "{phrase}"
        );
    }
    let lit = resolved_arg("reschedule{to: tomorrow at 09:30} on (it)");
    assert_eq!(
        (lit.ty.as_str(), lit.value.as_str()),
        ("datetime", "2026-06-16T09:30")
    );
    let lit = resolved_arg("reschedule{to: friday at 14:00}");
    assert_eq!(lit.value, "2026-06-19T14:00");
}

#[test]
fn a_day_the_month_lacks_does_not_resolve() {
    assert!(canon::relative_day("the 31st", REL_TODAY).is_err());
    assert_eq!(
        canon::relative_day("the 31st", "2026-07-01").as_deref(),
        Ok("2026-07-31")
    );
}

#[test]
fn relative_operands_and_windows_resolve_to_absolute_trees() {
    let resolved = canon::parse_for_execution(
        "show (tasks that (due_at < friday and due_at >= yesterday at 08:00))",
        REL_TODAY,
    )
    .expect("resolves");
    let absolute =
        canon::parse("show (tasks that (due_at < 2026-06-19 and due_at >= 2026-06-14T08:00))")
            .expect("parses");
    assert_eq!(resolved, absolute);
    for (window, want) in [
        ("next friday", "2026-06-26"),
        ("last friday", "2026-06-12"),
        ("friday", "2026-06-19"),
        ("the 3rd", "2026-07-03"),
        ("in 3 days", "2026-06-18"),
    ] {
        let resolved =
            canon::parse_for_execution(&format!("show (tasks during {window})"), REL_TODAY)
                .expect("resolves");
        let absolute = canon::parse(&format!("show (tasks during {want})")).expect("parses");
        assert_eq!(resolved, absolute, "{window}");
        let resolved = canon::parse_for_execution(
            &format!("show (tasks that (due_at during {window}))"),
            REL_TODAY,
        )
        .expect("resolves");
        let absolute =
            canon::parse(&format!("show (tasks that (due_at during {want}))")).expect("parses");
        assert_eq!(resolved, absolute, "{window}");
    }
    // `today` inside a window stays the PHRASE
    let tree = canon::parse("show (tasks during today)").expect("parses");
    assert!(matches!(
        tree,
        canon::Turn::Show(canon::Set::During {
            window: canon::Window::Phrase(_),
            ..
        })
    ));
}

#[test]
fn relative_dates_round_trip_in_every_position() {
    for text in [
        "reschedule{to: friday} on (it)",
        "reschedule{to: friday at 14:00} on (it)",
        "reschedule{to: next monday, b: last sunday at 23:59} on (it)",
        "reschedule{to: today, b: tomorrow at 09:30, c: yesterday}",
        "reschedule{to: the 21st, b: the 3rd at 07:05, c: in 3 days at 12:00}",
        "show (tasks that (due_at < friday))",
        "show (tasks that (due_at >= last friday at 08:00))",
        "show (tasks that (due_at <= the 21st and due_at > in 3 days))",
        "show (tasks during friday)",
        "show (tasks during next friday)",
        "show (tasks during last friday)",
        "show (tasks during the 3rd)",
        "show (tasks during in 3 days)",
        "show (tasks that (due_at during next sunday))",
    ] {
        let tree = canon::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"));
        let again = canon::parse(&tree.to_canonical()).expect("re-parses");
        assert_eq!(again, tree, "{text}");
    }
    let tree = canon::parse("reschedule{to: friday at 14:00}").expect("parses");
    let canon::Turn::Cmd(cmd) = &tree else {
        panic!()
    };
    assert_eq!(
        cmd.args[0].1,
        canon::ArgVal::Lit(canon::Lit {
            ty: "reldate".to_owned(),
            value: "friday at 14:00".to_owned()
        })
    );
    for bad in [
        "show (tasks during friday at 14:00)",
        "reschedule{to: the 32nd}",
        "reschedule{to: friday at 25:00}",
    ] {
        assert!(canon::parse(bad).is_err(), "{bad}");
    }
}

/// The links paragraph of the tools prompt is PRINTED from the executor's edge
/// table, so the prompt cannot name an edge the runtime does not walk (or miss
/// one it does). Regenerate with `cargo run -p centraid-candidates --bin
/// tool-links -- --write`.
#[test]
fn tools_md_links_match_the_edge_table() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../experiments/toolchat/TOOLS.md"
    );
    let text = std::fs::read_to_string(path).expect("TOOLS.md is readable");
    let block = crate::exec::links_paragraph();
    assert!(
        text.contains(&block),
        "TOOLS.md's links paragraph differs from exec::EDGES; expected:\n{block}"
    );
}

/// A read turn ends on `answer`, never on a `show`; `done` commits nothing of
/// its own; `answer` takes a set or a value and nothing else.
#[test]
fn a_read_turn_ends_on_answer_and_done_only_stops() {
    use centraid_evalsuite::{Context, Plan, WorldTemplate};

    use crate::tools::ToolSession;

    let template = WorldTemplate::build().expect("the suite world builds");
    let dealt = template
        .deal_with_ids("answer-test")
        .expect("a world deals");
    let mut ctx = Context::new(&dealt);
    let mut tools = ToolSession::default();

    tools.begin_turn();
    let shown = tools.call("show (tasks)", &mut ctx);
    assert!(shown.end.is_none(), "a show only looks: {}", shown.obs);
    assert!(shown.obs.starts_with("#1 "), "{}", shown.obs);
    let stopped = tools.call("done", &mut ctx);
    assert_eq!(
        stopped.end,
        Some(Plan::Declined {
            reason: "none".to_owned()
        }),
        "done after a plain show answers nothing"
    );

    tools.begin_turn();
    let answered = tools.call("answer #1", &mut ctx);
    assert!(
        matches!(&answered.end, Some(Plan::Ids(ids)) if ids.len() == 1),
        "answer commits its rows"
    );
    assert!(
        answered.obs.starts_with("#1 "),
        "and shows them: {}",
        answered.obs
    );

    tools.begin_turn();
    let counted = tools.call("answer count of (tasks)", &mut ctx);
    assert!(
        matches!(counted.end, Some(Plan::Value(_))),
        "{}",
        counted.obs
    );

    tools.begin_turn();
    let asked = tools.call("ask \"Which Neha — Rao or Kulkarni?\"", &mut ctx);
    assert_eq!(
        asked.end,
        Some(Plan::Declined {
            reason: "clarify".to_owned()
        }),
        "ask ends the turn as a clarify"
    );
    assert!(asked.obs.starts_with("asked: Which Neha"), "{}", asked.obs);
    tools.begin_turn();
    let empty = tools.call("ask", &mut ctx);
    assert!(
        empty.end.is_none() && empty.obs.starts_with("error: "),
        "{}",
        empty.obs
    );

    tools.begin_turn();
    let wrong = tools.call("answer nothing", &mut ctx);
    assert!(
        wrong.end.is_none() && wrong.obs.starts_with("error: "),
        "{}",
        wrong.obs
    );
}
