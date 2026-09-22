//! THE HARNESS, PROVED — over the real suite.
//!
//! The method rule is the first test in this file and everything else supports
//! it: every case reachable by hand, 0 failures, before any model runs.
//!
//! Two tests fail for two different reasons and the difference matters.
//! `every_id_the_suite_names_is_in_the_world` goes red when the SUITE and the
//! WORLD have drifted apart — a row was reseeded, an id moved — and no amount
//! of work on a candidate would fix it. `the_reference_passes_every_case` goes
//! red when a case is not reachable through the doors that exist, which is a
//! finding about the product. Running the first before the second is what
//! stops the second's failures being read as the wrong thing.

use std::path::PathBuf;
use std::sync::OnceLock;

use super::*;
use crate::reference::Reference;

/// The suite, WITH ITS HANDLES RESOLVED against the world this file builds.
///
/// `suite.json` holds no uuid — see [`crate::handles`] — so nothing here means
/// anything until the handles are turned into the ids this build minted.
fn suite() -> Suite {
    let mut suite = Suite::read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("suite.json"))
        .expect("the suite reads");
    suite
        .resolve(&template().inventory)
        .expect("every handle names exactly one row of the world");
    suite
}

/// ONE WORLD BUILT FOR THE WHOLE FILE. Seeding runs ~170 typed commands and a
/// blob store; every test here deals a copy of it instead.
fn template() -> &'static WorldTemplate {
    static TEMPLATE: OnceLock<WorldTemplate> = OnceLock::new();
    TEMPLATE.get_or_init(|| WorldTemplate::build().expect("the world builds"))
}

/// **ONE REFERENCE RUN FOR THE WHOLE FILE.**
///
/// A full pass of the hand-written reference over the corpus is the single
/// most expensive thing in this file — one private world per session, a turn
/// judged against a row-level digest — and five tests wanted exactly the same
/// one. They ran it five times, and `cargo test -p centraid-evalsuite` took
/// seventeen minutes for a suite that a candidate answers in two.
///
/// The report is immutable and every reader of it is a reader, so there is
/// nothing to share BUT the answer. A test that needs a different candidate,
/// a mutated suite or a fresh world still runs its own — this is not a cache
/// of "a run", it is the one run of THE REFERENCE OVER THE UNCHANGED SUITE.
fn reference_report() -> &'static Report {
    static REPORT: OnceLock<Report> = OnceLock::new();
    REPORT.get_or_init(|| run(&suite(), template(), &Reference).expect("the run finishes"))
}

/// **THE SESSIONS A WRITE-SIDE TEST IS ACTUALLY ABOUT.**
///
/// A test asking "does any broken writer pass a write turn" runs a candidate
/// over 120 sessions to look at the 40-odd that write. Cutting the other
/// eighty is not a weaker test — no turn it asserts anything about is dropped
/// — it is the same assertion over the sessions the assertion mentions, and it
/// is most of the minutes `cargo test` used to spend here.
fn sessions_that_write(whole: &Suite) -> Suite {
    Suite {
        version: whole.version,
        today: whole.today.clone(),
        handles: whole.handles.clone(),
        sessions: whole
            .sessions
            .iter()
            .filter(|session| {
                session.turns.iter().any(|turn| {
                    matches!(
                        turn.expected,
                        Expected::Write { .. } | Expected::WriteSet { .. }
                    )
                })
            })
            .cloned()
            .collect(),
    }
}

/// EVERY ID THE SUITE NAMES IS A ROW OF THE WORLD.
///
/// Run this before reading a reference failure. The suite names rows by STABLE
/// HANDLE now, and resolution is what turns a handle into this build's id — so
/// what this test really proves is that resolution left nothing behind. A
/// handle that named no row, or two, would already have stopped [`suite`] by
/// name; this is the belt to that brace.
#[test]
fn every_id_the_suite_names_is_in_the_world() {
    let world: std::collections::BTreeSet<&str> = template()
        .inventory
        .entities
        .iter()
        .map(|entity| entity.id.as_str())
        .collect();
    let suite = suite();
    let mut absent: Vec<String> = Vec::new();
    for session in &suite.sessions {
        for turn in &session.turns {
            for id in named_ids(&turn.expected) {
                if !world.contains(id.as_str()) {
                    absent.push(format!("{} names {id}", session.id));
                }
            }
        }
    }
    assert!(
        absent.is_empty(),
        "{} id(s) in the suite are not rows of the seeded world — the suite and \
         `crates/evalworld` have drifted apart and the suite needs re-deriving from \
         a fresh `inventory.json`:\n  {}",
        absent.len(),
        absent.join("\n  ")
    );
}

/// Every row id a case names, wherever it names one.
fn named_ids(expected: &Expected) -> Vec<String> {
    fn from_args(args: &Map<String, Value>) -> Vec<String> {
        ["id", "party_id", "album_id", "group_id"]
            .iter()
            .filter_map(|key| args.get(*key).and_then(Value::as_str))
            .filter(|value| *value != "me")
            .map(str::to_owned)
            .collect()
    }
    match expected {
        Expected::Ids { ids, .. } => ids.clone(),
        Expected::Write { args, .. } => from_args(args),
        Expected::WriteSet { writes, .. } => writes
            .iter()
            .flat_map(|write| from_args(&write.args))
            .collect(),
        Expected::Value { .. } | Expected::NoAction { .. } => Vec::new(),
    }
}

/// THE METHOD RULE, AS A TEST. Every case reachable by hand, 0 failures.
#[test]
fn the_reference_passes_every_case() {
    let report = reference_report();
    let failures: Vec<String> = report
        .failures()
        .iter()
        .flat_map(|session| {
            session.turns.iter().filter_map(move |turn| {
                turn.complaint
                    .as_ref()
                    .map(|complaint| format!("{} {:?}: {complaint}", session.id, turn.request))
            })
        })
        .collect();
    assert!(
        failures.is_empty(),
        "the hand-written reference cannot reach {} case(s):\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
    assert!(!report.by_category().is_empty(), "nothing was categorised");
}

/// A SESSION CANNOT SEE ANOTHER SESSION'S WRITES.
///
/// Two sessions asking the same read either side of a write: if the world were
/// shared, the second would see the first one's row and the suite would score
/// differently depending on the order its sessions happen to sit in.
#[test]
fn every_session_runs_against_a_fresh_world() {
    struct WritesThenCounts;
    impl CandidateRuntime for WritesThenCounts {
        fn name(&self) -> &str {
            "probe"
        }
        fn session(&self, _session: &Session) -> Box<dyn Candidate> {
            Box::new(Self)
        }
    }
    impl Candidate for WritesThenCounts {
        fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
            if request == "write" {
                ctx.write("schedule.add_task", serde_json::json!({ "title": ESCAPEE }))
                    .expect("the task is added");
                // A WRITE TURN IS A WRITE TURN. Counting in the same breath
                // would make this an `ids` turn that changed the vault, which
                // is now a failure in its own right — and a real one, so the
                // probe is shaped like a real conversation instead.
                return Plan::Wrote;
            }
            let count = ctx
                .open(App::Tasks)
                .expect("the board opens")
                .iter()
                .filter(|row| row.label == ESCAPEE)
                .count();
            Plan::Ids(vec![count.to_string()])
        }
    }
    const ESCAPEE: &str = "A row that must not escape";
    let counts = |label: &str| Expected::Ids {
        entity: "schedule.task".to_owned(),
        ids: vec![label.to_owned()],
        ordered: true,
        order_by: Some("the order they were written".to_owned()),
    };

    let suite = Suite {
        version: 1,
        today: "2026-06-15".to_owned(),
        handles: BTreeMap::new(),
        sessions: vec![
            Session {
                id: "writer".to_owned(),
                category: "probe".to_owned(),
                correlation_group: None,
                turns: vec![
                    Turn {
                        request: "write".to_owned(),
                        expected: Expected::Write {
                            predicate: "task_created".to_owned(),
                            args: [("title".to_owned(), Value::String(ESCAPEE.to_owned()))]
                                .into_iter()
                                .collect(),
                        },
                    },
                    Turn {
                        request: "read".to_owned(),
                        expected: counts("1"),
                    },
                ],
            },
            Session {
                id: "reader".to_owned(),
                category: "probe".to_owned(),
                correlation_group: None,
                turns: vec![Turn {
                    request: "read".to_owned(),
                    expected: counts("0"),
                }],
            },
        ],
    };
    let report = run(&suite, template(), &WritesThenCounts).expect("the run finishes");
    assert!(
        report.all_passed(),
        "a write leaked between sessions: {:?}",
        report
            .failures()
            .iter()
            .map(|session| (&session.id, &session.turns))
            .collect::<Vec<_>>()
    );
}

/// THE HAZARD, STATED AS A TEST.
///
/// The Tasks board hands back a soft-deleted task and the FTS door does not.
/// The harness does not adopt either door's answer: it stamps every row from
/// the row's own `deleted_at`, so a scorer built on `VaultRow::live` is right
/// whichever door answered — and stays right the day Tasks is fixed.
#[test]
fn a_trashed_task_comes_back_from_the_board_and_is_stamped_not_live() {
    let dealt = template().deal().expect("a world is dealt");
    let ctx = Context::new(&dealt);
    let board = ctx.open(App::Tasks).expect("the board opens");
    let trashed = board
        .iter()
        .find(|row| row.label == "Return the library books")
        .expect(
            "the Tasks board no longer hands back a trashed task — the defect is FIXED. \
             This test and the module note about it can go.",
        );
    assert!(
        !trashed.live,
        "the board's trashed task was stamped live; the scorer would answer with a row \
         the member deleted"
    );
    // AND THE OTHER DOOR SIMPLY DOES NOT HOLD IT — which is the disagreement.
    let hits = ctx
        .search("schedule.task", "library", 10)
        .expect("the search door answers");
    assert!(
        hits.is_empty(),
        "the FTS door now holds the trashed task too, so there is no disagreement to \
         rule on: {hits:?}"
    );
}

/// EVERY DOOR OPENS, AND NONE OF THEM IS EMPTY.
///
/// A board that answers nothing scores every candidate as perfect at that app,
/// which is the failure the world's own suite exists to prevent one layer
/// down. This is the same assertion at the harness's own seam.
#[test]
fn every_app_door_answers() {
    let dealt = template().deal().expect("a world is dealt");
    let ctx = Context::new(&dealt);
    for app in App::all() {
        let rows = ctx
            .open(app)
            .unwrap_or_else(|complaint| panic!("{} does not open: {complaint}", app.id()));
        assert!(
            rows.iter().any(|row| row.live),
            "{} answered no live rows; every candidate scores full marks on it",
            app.id()
        );
    }
}

/// THE SCORER IS NOT FOOLED BY THE RIGHT ANSWER IN THE WRONG SHAPE.
#[test]
fn a_shape_mismatch_fails() {
    let predicates = predicates();
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let expected = Expected::Write {
        predicate: "task_completed".to_owned(),
        args: Map::new(),
    };
    let complaint = judge(
        &expected,
        &Plan::Ids(vec!["anything".to_owned()]),
        0,
        &[],
        &probe,
        &predicates,
        &licenses(),
    );
    assert!(
        complaint.is_some_and(|text| text.contains("expects a write")),
        "answering with rows passed a write case"
    );
}

/// A `no_action` CASE IS AN OUTCOME, NOT A PROMISE: declining while writing is
/// a failure, and the harness counts the writes rather than believing the word.
#[test]
fn declining_while_writing_fails() {
    let predicates = predicates();
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let expected = Expected::NoAction {
        reason: "clarify".to_owned(),
        why: None,
    };
    let plan = Plan::Declined {
        reason: "clarify".to_owned(),
    };
    assert!(judge(&expected, &plan, 0, &[], &probe, &predicates, &licenses()).is_none());
    assert!(
        judge(&expected, &plan, 1, &[], &probe, &predicates, &licenses())
            .is_some_and(|text| text.contains("write")),
        "a candidate that wrote and then said it had not was scored as correct"
    );
}

/// THE DIAGNOSTIC A BINARY VERDICT THROWS AWAY.
///
/// "Four of the five Emerald Bay rows, missing exactly the Locker one" and
/// "nothing at all" are the same score, and the first is the finding that case
/// was built to produce. The verdict stays all-or-nothing; the overlap is what
/// makes the two distinguishable in a report.
#[test]
fn a_partly_right_answer_is_recorded_as_partly_right() {
    struct DropsOne;
    impl CandidateRuntime for DropsOne {
        fn name(&self) -> &str {
            "drops one"
        }
        fn session(&self, _session: &Session) -> Box<dyn Candidate> {
            Box::new(Self)
        }
    }
    impl Candidate for DropsOne {
        fn turn(&mut self, _request: &str, _ctx: &mut Context<'_>) -> Plan {
            Plan::Ids(vec!["a".to_owned(), "b".to_owned()])
        }
    }
    let suite = Suite {
        version: 1,
        today: "2026-06-15".to_owned(),
        handles: BTreeMap::new(),
        sessions: vec![Session {
            id: "partial".to_owned(),
            category: "probe".to_owned(),
            correlation_group: None,
            turns: vec![Turn {
                request: "rows".to_owned(),
                expected: Expected::Ids {
                    entity: "*".to_owned(),
                    ids: vec!["a".to_owned(), "b".to_owned(), "c".to_owned()],
                    ordered: false,
                    order_by: None,
                },
            }],
        }],
    };
    let report = run(&suite, template(), &DropsOne).expect("the run finishes");
    assert!(!report.all_passed(), "two of three rows passed as correct");
    let partial = report.partial_rows();
    assert_eq!(partial.len(), 1, "the near miss was not recorded");
    let overlap = partial[0].1.overlap.as_ref().expect("an overlap");
    assert_eq!((overlap.hit, overlap.expected), (2, 3));
    assert_eq!(overlap.missing, vec!["c".to_owned()]);
    assert!(overlap.extra.is_empty());
}

/// A SYSTEM THAT ONLY EVER ASKS MUST NOT LOOK GOOD.
///
/// It passes the turns that wanted a question and nothing else, so its recall
/// is perfect and its precision is terrible — and a headline that folded the
/// two together would hand it free points for never answering anything.
#[test]
fn an_always_clarify_candidate_scores_perfect_recall_and_poor_precision() {
    struct AlwaysClarify;
    impl CandidateRuntime for AlwaysClarify {
        fn name(&self) -> &str {
            "always clarify"
        }
        fn session(&self, _session: &Session) -> Box<dyn Candidate> {
            Box::new(Self)
        }
    }
    impl Candidate for AlwaysClarify {
        fn turn(&mut self, _request: &str, _ctx: &mut Context<'_>) -> Plan {
            Plan::Declined {
                reason: "clarify".to_owned(),
            }
        }
    }
    let report = run(&suite(), template(), &AlwaysClarify).expect("the run finishes");
    let clarify = report
        .decline_scores()
        .into_iter()
        .find(|score| score.reason == "clarify")
        .expect("clarify is scored");
    assert_eq!(
        clarify.recall(),
        Some(1.0),
        "an always-clarify candidate did not find every clarify case"
    );
    let precision = clarify.precision().expect("it declined at least once");
    assert!(
        precision < 0.25,
        "asking on every turn scored {precision} precision; the headline would be flattering it"
    );
}

/// **A REVEAL THAT NEVER HAPPENED MUST FAIL.**
///
/// Revealing a sealed cell changes no row a scorer would normally read — the
/// plaintext never lands anywhere and the item is untouched. So if nothing
/// inspected the access receipt, `locker_field_revealed` would be a predicate
/// no candidate could fail, and the turn would be a free point dressed as a
/// hard one. This runs the Locker session with a candidate that declines
/// instead of revealing and asserts the turn goes RED.
#[test]
fn declining_to_reveal_fails_the_locker_reveal_case() {
    struct NeverReveals;
    impl CandidateRuntime for NeverReveals {
        fn name(&self) -> &str {
            "never reveals"
        }
        fn session(&self, _session: &Session) -> Box<dyn Candidate> {
            Box::new(Self)
        }
    }
    impl Candidate for NeverReveals {
        fn turn(&mut self, _request: &str, _ctx: &mut Context<'_>) -> Plan {
            Plan::Declined {
                reason: "refuse".to_owned(),
            }
        }
    }

    let whole = suite();
    let reveals: Vec<Session> = whole
        .sessions
        .iter()
        .filter(|session| {
            session.turns.iter().any(|turn| {
                matches!(&turn.expected, Expected::Write { predicate, .. }
                    if predicate == "locker_field_revealed")
            })
        })
        .cloned()
        .collect();
    assert!(
        !reveals.is_empty(),
        "no case expects `locker_field_revealed`; this test is guarding nothing"
    );

    // AND THE PREDICATE IS RED ON A FRESH WORLD, which is what makes the run
    // below meaningful rather than a tautology about a declined plan.
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let item = ctx_first_locker_id(&dealt);
    let mut args = Map::new();
    args.insert("id".to_owned(), Value::String(item));
    args.insert("field".to_owned(), Value::String("password".to_owned()));
    assert!(
        predicates()["locker_field_revealed"](&probe, &args).is_err(),
        "the seeded world already satisfies `locker_field_revealed`, so the case \
         cannot fail and is not scoring anything"
    );

    let report = run(
        &Suite {
            sessions: reveals,
            ..whole
        },
        template(),
        &NeverReveals,
    )
    .expect("the run finishes");
    assert!(
        !report.all_passed(),
        "a candidate that never revealed anything passed the reveal case; the \
         access receipt is not being inspected and the turn is unfalsifiable"
    );
}

/// The first live Locker item of a dealt world, for the probe above.
fn ctx_first_locker_id(dealt: &Dealt) -> String {
    Context::new(dealt)
        .open(App::Locker)
        .expect("the shelf opens")
        .into_iter()
        .find(|row| row.live)
        .expect("the shelf holds an item")
        .id
}

/// **THE REFERENCE READS A WRITE'S WORDS FROM THE CASE, NOT FROM ITS OWN
/// SOURCE.**
///
/// A reference that spelled the expense description in a literal went red the
/// moment somebody renamed it in the suite, and the failure read as a scoring
/// bug when it was a coupling one. This renames three write arguments and
/// asserts the run is still clean, so the next rename cannot reintroduce the
/// trap quietly.
#[test]
fn renaming_a_write_argument_does_not_break_the_reference() {
    let mut suite = suite();
    let mut renamed = 0usize;
    for session in &mut suite.sessions {
        for turn in &mut session.turns {
            let args: Vec<&mut Map<String, Value>> = match &mut turn.expected {
                Expected::Write { args, .. } => vec![args],
                Expected::WriteSet { writes, .. } => {
                    writes.iter_mut().map(|write| &mut write.args).collect()
                }
                _ => Vec::new(),
            };
            for args in args {
                for key in ["description", "title", "summary"] {
                    if let Some(Value::String(value)) = args.get_mut(key) {
                        value.push_str(" (renamed)");
                        renamed += 1;
                    }
                }
            }
        }
    }
    assert!(renamed >= 3, "only {renamed} write argument(s) to rename");

    let report = run(&suite, template(), &Reference).expect("the run finishes");
    let stuck: Vec<String> = report
        .failures()
        .iter()
        .flat_map(|session| {
            session.turns.iter().filter_map(move |turn| {
                turn.complaint
                    .as_ref()
                    .map(|complaint| format!("{}: {complaint}", session.id))
            })
        })
        .collect();
    assert!(
        stuck.is_empty(),
        "the reference is coupled to a write argument's literal text:\n  {}",
        stuck.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// The graded score (G12), proved rather than asserted.
// ---------------------------------------------------------------------------

/// **F1, AT ITS EDGES.** Each of these is a decision, not a default: an empty
/// expectation met by an empty answer is right, an empty expectation met by
/// rows is wrong, and a breadth-dump that contains every wanted row scores a
/// fraction rather than a pass.
#[test]
fn partial_credit_is_f1_and_its_edges_are_decided() {
    let overlap = |expected: usize, answered: usize, hit: usize| Overlap {
        expected,
        answered,
        hit,
        missing: Vec::new(),
        extra: Vec::new(),
    };
    // Exact.
    assert!((overlap(5, 5, 5).f1() - 1.0).abs() < 1e-9);
    // Four of the five Emerald Bay rows — the finding `s16` exists to produce,
    // and the reason a binary score alone is not enough.
    assert!((overlap(5, 4, 4).f1() - 0.888_888_9).abs() < 1e-6);
    // Nothing at all, which the binary verdict scores IDENTICALLY to the line
    // above. This is the whole point of the second column.
    assert!((overlap(5, 0, 0).f1() - 0.0).abs() < 1e-9);
    // A BREADTH-DUMP: the whole board of forty rows, holding all five wanted.
    // Perfect recall, and it must not score anywhere near a pass.
    assert!(
        overlap(5, 40, 5).f1() < 0.25,
        "a forty-row dump containing every wanted row scored {}",
        overlap(5, 40, 5).f1()
    );
    // An empty expectation, answered emptily and answered with rows.
    assert!((overlap(0, 0, 0).f1() - 1.0).abs() < 1e-9);
    assert!((overlap(0, 3, 0).f1() - 0.0).abs() < 1e-9);
}

/// **THE GRADED SCORE MUST NOT REWARD BREADTH-DUMPING.**
///
/// A candidate that answers a rows turn with the WHOLE Tasks board contains
/// every wanted row, so its id recall is perfect — exactly the shape of
/// candidate a recall-based graded score would flatter. Its strict verdict
/// must be zero and its graded score must stay near the floor. (`run-nulls`
/// measures the same property on the real roster, where `EverythingOfEntity`
/// leads on id recall at 61.8% and is graded 8.9%; this is that property as a
/// test, so it cannot quietly stop holding.)
#[test]
fn the_graded_score_still_punishes_breadth_dumping() {
    struct Dumper;
    impl Candidate for Dumper {
        fn turn(&mut self, _request: &str, ctx: &mut Context<'_>) -> Plan {
            Plan::Ids(
                ctx.open(App::Tasks)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|row| row.id)
                    .collect(),
            )
        }
    }
    impl CandidateRuntime for Dumper {
        fn name(&self) -> &str {
            "Dumper"
        }
        fn session(&self, _session: &Session) -> Box<dyn Candidate> {
            Box::new(Self)
        }
    }

    let board = {
        let dealt = template().deal().expect("the world deals");
        let ctx = Context::new(&dealt);
        ctx.open(App::Tasks).expect("the tasks board opens")
    };
    let wanted: Vec<String> = board
        .iter()
        .filter(|row| row.live)
        .take(2)
        .map(|row| row.id.clone())
        .collect();
    assert_eq!(wanted.len(), 2, "the world seeds at least two live tasks");
    assert!(
        board.len() > 8,
        "the board is too small for a dump to be a dump: {}",
        board.len()
    );

    let suite = Suite {
        version: 1,
        today: "2026-06-15".to_owned(),
        handles: BTreeMap::new(),
        sessions: vec![Session {
            id: "dump".to_owned(),
            category: "probe".to_owned(),
            correlation_group: None,
            turns: vec![Turn {
                request: "two tasks".to_owned(),
                expected: Expected::Ids {
                    entity: "schedule.task".to_owned(),
                    ids: wanted,
                    ordered: false,
                    order_by: None,
                },
            }],
        }],
    };
    let report = run(&suite, template(), &Dumper).expect("the run finishes");
    let overlap = report.sessions[0].turns[0]
        .overlap
        .as_ref()
        .expect("a rows turn carries an overlap");
    assert_eq!(overlap.hit, 2, "the dump contains every wanted row");
    assert_eq!(
        report.strict_sessions().0,
        0,
        "the strict verdict must defeat a breadth-dumper outright"
    );
    assert!(
        report.graded_score() < 0.35,
        "the graded score paid a breadth-dumper {:.3} on perfect recall \
         — F1 is not doing its job and the metric is wrong",
        report.graded_score()
    );
}

/// G7/G4 — the two turns that cannot be scored on their own are named, and
/// nothing else is.
#[test]
fn the_combination_only_turns_are_exactly_the_empty_expectations() {
    let report = reference_report();
    let keys: Vec<String> = report
        .combination_only()
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    assert_eq!(keys, vec!["s06/t3".to_owned(), "s59/t2".to_owned()]);
}

/// G15 — a `write_set` that declares an order is REFUSED, loudly, rather than
/// having the flag quietly ignored.
#[test]
fn an_ordered_write_set_is_refused_rather_than_ignored() {
    let expected = Expected::WriteSet {
        writes: vec![WriteExpectation {
            predicate: "task_completed".to_owned(),
            args: Map::new(),
        }],
        ordered: true,
    };
    let predicates = predicates();
    let dealt = template().deal().expect("the world deals");
    let probe = Probe { dealt: &dealt };
    let complaint = judge(
        &expected,
        &Plan::Wrote,
        1,
        &[],
        &probe,
        &predicates,
        &licenses(),
    )
    .expect("an ordered write_set is refused");
    assert!(
        complaint.contains("refuses to score"),
        "the refusal does not say it is a refusal: {complaint}"
    );
}

/// **NO WRITE EXPECTATION IS TRUE OF THE WORLD BEFORE THE CONVERSATION
/// STARTS** — over BOTH corpora, every predicate, every argument.
///
/// This is DEFECT #4 generalised from the three predicates the validator
/// happens to know about to the PROPERTY. `interaction_logged` was satisfied
/// by seed state; so was `settled_up` on `s74/t1`, for two releases, because
/// the world holds a settlement naming Ana in the trip group and the scorer
/// never read the amount. A case a candidate passes by doing nothing is not a
/// case; it is a free point that reads as competence.
///
/// The check is exhaustive and cheap: deal an untouched world, ask every
/// write predicate every case names, and require every single one to REFUSE.
#[test]
fn no_write_expectation_holds_against_the_untouched_world() {
    let predicates = predicates();
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let mut free: Vec<String> = Vec::new();
    for file in ["suite.json", "blind.json"] {
        let mut whole =
            Suite::read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(file)).expect("reads");
        whole
            .resolve(&template().inventory)
            .expect("every handle names exactly one row");
        for session in &whole.sessions {
            for (index, turn) in session.turns.iter().enumerate() {
                let writes: Vec<(&str, &Map<String, Value>)> = match &turn.expected {
                    Expected::Write { predicate, args } => vec![(predicate.as_str(), args)],
                    Expected::WriteSet { writes, .. } => writes
                        .iter()
                        .map(|write| (write.predicate.as_str(), &write.args))
                        .collect(),
                    _ => Vec::new(),
                };
                for (predicate, args) in writes {
                    // THE ONE DELIBERATE EXCEPTION, and it is not an
                    // exception to the property. `no_interaction_logged` is
                    // the NEGATIVE half of a paired write: it asserts a party
                    // was left alone, so it is true of the untouched world by
                    // construction and could not be anything else. It scores
                    // only beside its positive partner, which is checked here
                    // like every other.
                    if predicate == "no_interaction_logged" {
                        continue;
                    }
                    if check_one(predicate, args, &probe, &predicates).is_ok() {
                        free.push(format!(
                            "{file} {}/t{} {predicate}{args:?}",
                            session.id,
                            index + 1
                        ));
                    }
                }
            }
        }
    }
    assert!(
        free.is_empty(),
        "{} write expectation(s) are satisfied by the SEEDED WORLD, so a candidate that \
         does nothing at all passes them:\n  {}",
        free.len(),
        free.join("\n  ")
    );
}

/// **A `Plan::Wrote` WITH NO WRITE BEHIND IT FAILS.**
///
/// The narrow version of the test above, at the seam rather than over the
/// corpus: `judge` is handed a confident claim, an empty changed-row set and
/// a predicate the world does not satisfy, and must refuse it.
#[test]
fn claiming_a_write_without_making_one_fails() {
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let mut args = Map::new();
    args.insert(
        "title".to_owned(),
        Value::String("A task nobody added".to_owned()),
    );
    let expected = Expected::Write {
        predicate: "task_created".to_owned(),
        args,
    };
    assert!(
        judge(
            &expected,
            &Plan::Wrote,
            0,
            &[],
            &probe,
            &predicates(),
            &licenses()
        )
        .is_some(),
        "a candidate that said it wrote, wrote nothing, and changed nothing was scored correct"
    );
}

// ---------------------------------------------------------------------------
// The changed-row set (DEFECT #16).
// ---------------------------------------------------------------------------

/// **A READ MUST NOT WRITE.** A candidate that answers the right rows and
/// moves one on the way has edited the vault behind the member's back, and a
/// scorer that looked only at the ids it answered would call that correct.
#[test]
fn a_rows_turn_that_changes_the_vault_fails() {
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let expected = Expected::Ids {
        entity: "schedule.task".to_owned(),
        ids: vec!["a".to_owned()],
        ordered: false,
        order_by: None,
    };
    let moved = [RowChange {
        table: "schedule_task".to_owned(),
        id: "somebody-elses-task".to_owned(),
        kind: RowChangeKind::Modified,
    }];
    let plan = Plan::Ids(vec!["a".to_owned()]);
    assert!(
        judge(&expected, &plan, 0, &[], &probe, &predicates(), &licenses()).is_none(),
        "the right rows and an untouched vault is the right answer"
    );
    let complaint = judge(
        &expected,
        &plan,
        0,
        &moved,
        &probe,
        &predicates(),
        &licenses(),
    )
    .expect("a read that wrote is refused");
    assert!(
        complaint.contains("no vault change"),
        "the complaint does not name the property: {complaint}"
    );
}

/// **THE CORRECT WRITE PLUS COLLATERAL DAMAGE IS NOT THE CORRECT WRITE.**
///
/// The predicate holds — the task really did move — and three unrelated rows
/// moved with it. A scorer that read only the predicate would score this
/// identically to a clean edit.
#[test]
fn a_write_that_also_damages_bystanders_fails() {
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let task = Context::new(&dealt)
        .open(App::Tasks)
        .expect("the board opens")
        .into_iter()
        .find(|row| row.live && row.date.is_some())
        .expect("a live task with a due date");
    let due = task.date.clone().unwrap_or_default();
    let mut args = Map::new();
    args.insert("id".to_owned(), Value::String(task.id.clone()));
    args.insert("to".to_owned(), Value::String(due[..10].to_owned()));
    let expected = Expected::Write {
        predicate: "task_rescheduled".to_owned(),
        args,
    };
    let licensed = [RowChange {
        table: "schedule_task".to_owned(),
        id: task.id.clone(),
        kind: RowChangeKind::Modified,
    }];
    assert!(
        judge(
            &expected,
            &Plan::Wrote,
            1,
            &licensed,
            &probe,
            &predicates(),
            &licenses()
        )
        .is_none(),
        "the licensed row moving is the whole of the expected outcome"
    );
    let mut collateral = licensed.to_vec();
    collateral.push(RowChange {
        table: "knowledge_note".to_owned(),
        id: "a note nobody mentioned".to_owned(),
        kind: RowChangeKind::Modified,
    });
    let complaint = judge(
        &expected,
        &Plan::Wrote,
        1,
        &collateral,
        &probe,
        &predicates(),
        &licenses(),
    )
    .expect("collateral damage is refused");
    assert!(
        complaint.contains("no expectation licenses"),
        "the complaint does not name the property: {complaint}"
    );
}

/// **A PURGE IS NEVER LICENSED**, not even of the row the case names.
/// Centraid trashes; a row that is simply gone is a worse outcome than the one
/// the member asked for.
#[test]
fn removing_the_very_row_the_case_names_is_still_unlicensed() {
    let mut args = Map::new();
    args.insert("id".to_owned(), Value::String("t1".to_owned()));
    let license = licenses()["task_trashed"];
    let dealt = template().deal().expect("a world is dealt");
    let probe = Probe { dealt: &dealt };
    let gone = [RowChange {
        table: "schedule_task".to_owned(),
        id: "t1".to_owned(),
        kind: RowChangeKind::Removed,
    }];
    assert_eq!(license(&probe, &args).unlicensed(&gone).len(), 1);
}

/// **EVERY WRITE PREDICATE CARRIES A LICENCE.** A predicate with none cannot
/// be judged on its side effects, and the two tables drifting apart is exactly
/// how DEFECT #15 happened one layer up.
#[test]
fn every_write_predicate_has_a_licence() {
    let licensed: std::collections::BTreeSet<&str> = licenses().keys().copied().collect();
    let missing: Vec<&str> = predicates()
        .keys()
        .copied()
        .filter(|name| !licensed.contains(name))
        .collect();
    assert!(
        missing.is_empty(),
        "predicate(s) with no side-effect licence: {missing:?}"
    );
    let orphan: Vec<&str> = licensed
        .iter()
        .copied()
        .filter(|name| !predicates().contains_key(name))
        .collect();
    assert!(orphan.is_empty(), "licence(s) for no predicate: {orphan:?}");
}

/// **NOTHING IN THE BOOKKEEPING EXEMPTION HOLDS MEMBER CONTENT.**
///
/// Every name on that list is a hole in the side-effect score, so the list is
/// asserted rather than trusted: each entry carries a reason, and each names a
/// table of the write plane's own rather than one of the eight apps'.
#[test]
fn the_bookkeeping_exemptions_hold_no_member_content() {
    for (table, reason) in BOOKKEEPING {
        assert!(
            reason.len() > 40,
            "`{table}` is exempt with no reason worth reading"
        );
        assert!(
            table.starts_with("agent_")
                || ["access_receipt", "core_entity", "replica_meta"].contains(table),
            "`{table}` is exempt from the side-effect score and is not a write-plane table"
        );
    }
    // AND NO APP TABLE IS ON IT. `row_of` names the physical table behind
    // every entity a case can talk about; none of them may be exempt.
    for entity in [
        "knowledge.note",
        "core.party",
        "core.event",
        "schedule.task",
        "tally.expense",
        "core.document",
        "core.content_item",
        "locker.item",
        "core.place",
        "media.album",
        "tally.group",
        "people.important_date",
        "social.contact_channel",
        "core.activity",
        "tally.obligation",
        "tally.settlement",
    ] {
        let (table, _) = row_of(entity).expect("a known entity");
        assert!(
            !BOOKKEEPING.iter().any(|(name, _)| *name == table),
            "`{table}` holds member content and is exempt from the side-effect score"
        );
    }
}

// ---------------------------------------------------------------------------
// The writing instruments (DEFECT #16).
// ---------------------------------------------------------------------------

/// Every `session/turn` key whose case expects a write.
fn write_turn_keys(suite: &Suite) -> Vec<String> {
    suite
        .sessions
        .iter()
        .flat_map(|session| {
            session
                .turns
                .iter()
                .enumerate()
                .filter(|(_, turn)| {
                    matches!(
                        turn.expected,
                        Expected::Write { .. } | Expected::WriteSet { .. }
                    )
                })
                .map(move |(index, _)| format!("{}/t{}", session.id, index + 1))
        })
        .collect()
}

/// **THE THREE WAYS A WRITE GOES WRONG ALL SCORE ZERO, ON EVERY WRITE TURN.**
///
/// It did not happen; it happened to the wrong row; it happened and so did
/// three other things. Before these existed, every instrument in `nulls`
/// answered rows or declined, so the write half of the suite had a floor of
/// no candidates at all and had never been shown to discriminate. A turn any
/// of the three passes is a turn that is not scoring what it claims to.
#[test]
fn no_writing_instrument_passes_a_single_write_turn() {
    let suite = sessions_that_write(&suite());
    let wanted = write_turn_keys(&suite);
    assert!(
        wanted.len() >= 20,
        "only {} write turn(s) to measure",
        wanted.len()
    );
    let instruments: Vec<Box<dyn CandidateRuntime>> = vec![
        Box::new(crate::nulls::ClaimsWroteDoesNothing),
        Box::new(crate::nulls::WrongRowWriter),
        Box::new(crate::nulls::CollateralDamage),
    ];
    let mut free: Vec<String> = Vec::new();
    for runtime in &instruments {
        let report = run(&suite, template(), runtime.as_ref()).expect("the run finishes");
        for session in &report.sessions {
            for (index, turn) in session.turns.iter().enumerate() {
                let key = format!("{}/t{}", session.id, index + 1);
                if turn.passed && wanted.contains(&key) {
                    free.push(format!(
                        "{} passes {key} {:?}",
                        runtime.name(),
                        turn.request
                    ));
                }
            }
        }
    }
    assert!(
        free.is_empty(),
        "{} write turn(s) are passed by a deliberately broken writer:\n  {}",
        free.len(),
        free.join("\n  ")
    );
}

/// **AND `CollateralDamage` IS OTHERWISE THE REFERENCE.**
///
/// The instrument above is only evidence about the CHANGED-ROW SET if its
/// writes are the right ones: an instrument that failed the write turns
/// because it got them wrong would prove nothing. This asserts it fails every
/// write turn for the collateral damage specifically — the complaint names the
/// licence — and passes the read turns the reference passes.
#[test]
fn collateral_damage_fails_for_the_damage_and_not_for_the_write() {
    let suite = sessions_that_write(&suite());
    let report =
        run(&suite, template(), &crate::nulls::CollateralDamage).expect("the run finishes");
    let write_turns = write_turn_keys(&suite);
    let mut wrong_reason: Vec<String> = Vec::new();
    let mut read_failures: Vec<String> = Vec::new();
    for session in &report.sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            let key = format!("{}/t{}", session.id, index + 1);
            let Some(complaint) = &turn.complaint else {
                continue;
            };
            if write_turns.contains(&key) {
                if !complaint.contains("no expectation licenses") {
                    wrong_reason.push(format!("{key}: {complaint}"));
                }
            } else {
                read_failures.push(format!("{key}: {complaint}"));
            }
        }
    }
    assert!(
        wrong_reason.is_empty(),
        "the damaging instrument failed a write turn for some other reason, so the turn \
         is not evidence about collateral damage:\n  {}",
        wrong_reason.join("\n  ")
    );
    // The reference's own reads, unchanged: this instrument differs from it by
    // the damage and by nothing else.
    assert!(
        read_failures.is_empty(),
        "the damaging instrument also failed {} read turn(s), so it is not the reference \
         plus damage:\n  {}",
        read_failures.len(),
        read_failures.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// Lane T — the week convention, and the text-only reference's ratchet.
// ---------------------------------------------------------------------------

/// **ONE DEFINITION OF A WEEK.**
///
/// The corpus held two: `s01` was answered as a calendar week and `s64` as a
/// trailing seven days, and both passed. This pins the published table so a
/// third reading cannot be introduced by a helpful edit.
#[test]
fn the_week_convention_is_the_one_the_readme_publishes() {
    use crate::reference::calendar;
    let today = "2026-06-15";
    assert_eq!(calendar::weekday(today), 0, "the world's today is a Monday");
    for (phrase, from, to) in [
        ("today", "2026-06-15", "2026-06-15"),
        ("tomorrow", "2026-06-16", "2026-06-16"),
        ("yesterday", "2026-06-14", "2026-06-14"),
        ("this week", "2026-06-15", "2026-06-21"),
        ("last week", "2026-06-08", "2026-06-14"),
        ("next week", "2026-06-22", "2026-06-28"),
        ("this weekend", "2026-06-20", "2026-06-21"),
        ("last weekend", "2026-06-13", "2026-06-14"),
        ("this month", "2026-06-01", "2026-06-30"),
        ("last month", "2026-05-01", "2026-05-31"),
        ("next month", "2026-07-01", "2026-07-31"),
        // A ROLLING window, not a calendar one — the whole content of the rule.
        ("recently", "2026-06-09", "2026-06-15"),
        ("the next couple of months", "2026-06-15", "2026-08-15"),
    ] {
        let window = calendar::phrase(today, phrase)
            .unwrap_or_else(|| panic!("{phrase:?} is in the published table"));
        assert_eq!(
            (window.from.as_str(), window.to.as_str()),
            (from, to),
            "{phrase:?} moved"
        );
    }
    // A phrase the table does not hold is answered with nothing rather than
    // with a guess — a silently invented window is how two readings of "this
    // week" survived.
    assert!(calendar::phrase(today, "a week on friday").is_none());
}

/// **THE TEXT-ONLY REFERENCE'S AGREEMENT IS A RATCHET.**
///
/// `crate::reference::textref` reads the request and is never told which case
/// it is answering, so a turn it disagrees with is a turn where a plain
/// reading of the words lands somewhere the case does not. Every disagreement
/// has been adjudicated by hand (see `DEFECTS.md` #22). This asserts the
/// number never falls back: a case reworded out of agreeing with its own
/// words would otherwise be invisible.
///
/// It is a FLOOR and not an equality. Teaching the rules one more sentence
/// shape is a good change and must not be a red build; reading one fewer is
/// the regression.
#[test]
fn the_text_only_reference_never_agrees_with_fewer_turns_than_it_does_today() {
    /// What it reached on 2026-09-21, over `suite.json`. See `DEFECTS.md` #22.
    const FLOOR: usize = 22;
    let report = run(
        &suite(),
        template(),
        &crate::reference::textref::TextReference,
    )
    .expect("the run finishes");
    let agreed = report
        .sessions
        .iter()
        .flat_map(|session| &session.turns)
        .filter(|turn| turn.passed)
        .count();
    assert!(
        agreed >= FLOOR,
        "the text-only reference now agrees with {agreed} turn(s) of the suite, down from \
         {FLOOR}. Either a case was reworded away from what its own sentence says, or a \
         rule was lost — adjudicate before lowering this number."
    );
}

/// **NO ROW IS STAMPED AS CHANGED BEFORE IT WAS CREATED.**
///
/// All 36 trashed tasks and 667 completed ones carried
/// `deleted_at`/`completed_at` EARLIER than their own `created_at`, because
/// `schedule.add_task` was the one insert in `crates/vault/src/commands/
/// schedule.rs` that let `created_at` fall through to the column DEFAULT —
/// `strftime('now')`, the wall clock. A world claiming determinism was
/// stamping its tasks with whenever the build happened to run.
///
/// One documented exception: a People journal entry's `created_at` is the
/// entry's OWN day (`people.add_journal_entry` backdates it on purpose, so an
/// entry written about yesterday sorts where the member put it) while its
/// `updated_at` is when it was typed. That is the product's ruling, not a
/// defect, and it is named here rather than skipped silently.
#[test]
fn nothing_in_the_world_changed_before_it_was_created() {
    let dealt = template().deal().expect("the world deals");
    let probe = Probe { dealt: &dealt };
    let mut inverted: Vec<String> = Vec::new();
    for app in App::all() {
        for row in probe.board(app) {
            let Some((table, key)) = crate::row_of(&row.entity) else {
                continue;
            };
            let select = format!("{key}, created_at, deleted_at, completed_at, updated_at");
            let Some(found) = probe.row(table, key, &row.id, &select) else {
                continue;
            };
            let Some(created) = crate::text(&found, "created_at") else {
                continue;
            };
            for column in ["deleted_at", "completed_at", "updated_at"] {
                let Some(stamp) = crate::text(&found, column) else {
                    continue;
                };
                // THE ONE DOCUMENTED EXCEPTION, named rather than skipped.
                if column == "updated_at" && row.label.starts_with("People journal") {
                    continue;
                }
                if stamp < created {
                    inverted.push(format!(
                        "{table}/{} ({:?}): {column}={stamp} is before created_at={created}",
                        row.id, row.label
                    ));
                }
            }
        }
    }
    assert!(
        inverted.is_empty(),
        "{} row(s) in the seeded world changed before they were created:\n  {}",
        inverted.len(),
        inverted.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// THE COST COLUMNS, THE DIGEST CACHE, AND THE SCALE (Lane G).
//
// Everything below this line is about the harness measuring rather than the
// harness judging: what a turn cost, what the harness itself cost, and whether
// the score has a scale or only two ends.
// ---------------------------------------------------------------------------

/// **TWO FRESHLY DEALT WORLDS ARE THE SAME WORLD.**
///
/// [`run`] takes the digest before the first turn ONCE and primes every later
/// session's cache with it ([`Dealt::prime`]), which is sound only if dealing
/// is deterministic down to the row. If opening a vault ever stamps a row the
/// digest can see, this goes red and the optimisation comes out — it is not
/// an assumption anybody has to remember.
#[test]
fn two_fresh_deals_digest_alike() {
    let first = template().deal().expect("a world is dealt");
    let second = template().deal().expect("a second world is dealt");
    let left = first.digest();
    let right = second.digest();
    let moved = diff(&left, &right);
    assert!(
        moved.is_empty(),
        "two freshly dealt worlds differ in {} row(s): {:?}",
        moved.len(),
        moved.iter().take(5).collect::<Vec<_>>()
    );
}

/// **THE CACHE SKIPS SCANS, NEVER CHANGES.**
///
/// The gate is SQLite's own change counter, so a turn that wrote must still
/// arrive with its moved rows attached: this runs the one session whose turn
/// adds a task and requires the changed-row set to be non-empty. Paired with
/// `a_turn_that_writes_nothing_costs_no_vault_scan` (the cache does skip) and
/// `two_fresh_deals_digest_alike` (the priming is sound), the three of them
/// hold the optimisation down from both sides.
#[test]
fn a_write_turn_still_arrives_with_its_moved_rows_through_the_cache() {
    let suite = suite();
    let session = suite
        .sessions
        .iter()
        .find(|session| session.id == "s11")
        .expect("s11 is in the suite");

    /// The reference for one session, then a cold-scan comparison around it.
    struct One;
    impl CandidateRuntime for One {
        fn name(&self) -> &str {
            "one session"
        }
        fn session(&self, session: &Session) -> Box<dyn Candidate> {
            Reference.session(session)
        }
    }
    let single = Suite {
        version: suite.version,
        today: suite.today.clone(),
        handles: suite.handles.clone(),
        sessions: vec![session.clone()],
    };
    let report = run(&single, template(), &One).expect("the run finishes");
    let moved: usize = report
        .sessions
        .iter()
        .flat_map(|session| &session.turns)
        .map(|turn| turn.changes.len())
        .sum();
    assert!(
        moved > 0,
        "s11 writes a task, so the digest must see at least one row move"
    );
}

/// **EVERY DOOR IS METERED.** A run of the reference over the whole suite
/// opens boards, executes commands and seals a secret, and each of those has
/// to show up as calls, rows and microseconds — a meter that reads zero is
/// indistinguishable from a candidate that did nothing.
#[test]
fn the_cost_meter_charges_every_door_the_reference_uses() {
    let report = reference_report();
    let cost = report.cost();
    assert!(
        cost.total.calls_at("open") > 0,
        "the reference opens boards"
    );
    assert!(
        cost.total.rows_at("open") > 1000,
        "opening a board hands back the board: {} row(s)",
        cost.total.rows_at("open")
    );
    assert!(
        cost.total.calls_at("write") > 0 && cost.total.writes() > 0,
        "the reference executes commands"
    );
    assert!(cost.total.micros > 0, "a turn takes some time");
    assert!(
        cost.micros.p95 >= cost.micros.p50,
        "p95 is never below p50: {:?}",
        cost.micros
    );
    // THE COST IS NOT THE SCORE, and this is the assertion that says so: the
    // reference passes everything and is far from the cheapest thing that
    // could be run against this corpus.
    assert!(
        report.strict_sessions().0 > 0 && cost.total.rows() > 0,
        "a passing run still costs rows"
    );
}

/// **THE HARNESS PAYS FOR ITS OWN SCANS, AND PAYS FOR FEWER THAN IT USED TO.**
///
/// One scan per turn was the shape before the cache; the property that
/// replaced it is that a turn which moved no row takes no scan. Most of the
/// suite is reads, so the count has to come in well under the turn count — and
/// if it ever equals it, the cache has silently stopped working.
#[test]
fn a_turn_that_writes_nothing_costs_no_vault_scan() {
    let turns: usize = suite()
        .sessions
        .iter()
        .map(|session| session.turns.len())
        .sum();
    let report = reference_report();
    let scanned = report.scans;
    let writing = report
        .sessions
        .iter()
        .flat_map(|session| &session.turns)
        .filter(|turn| !turn.changes.is_empty())
        .count();
    assert!(
        scanned * 2 < turns,
        "{scanned} of {turns} turns paid for a full vault scan — the digest cache is not working"
    );
    // AND IT SKIPPED NOTHING IT SHOULD HAVE TAKEN: every turn that moved a row
    // had to be scanned for, so the scan count can never fall BELOW the number
    // of turns whose changed-row set is non-empty.
    assert!(
        scanned >= writing,
        "{scanned} scan(s) cannot have produced {writing} turn(s) of changed rows"
    );
}

/// **THE SUITE RANKS.** Review item B14: nothing had ever been scored between
/// 6% and 100%, so nothing established that the score has a scale.
///
/// Two dial settings rather than the bin's five, because each one is a full
/// run of the corpus and this is a test rather than a report — the bin
/// `run-ranking` prints the whole sweep over both corpora.
#[test]
fn the_score_is_monotone_in_how_often_a_candidate_is_right() {
    // A SLICE, NOT THE WHOLE CORPUS. Two dial settings are two full passes of
    // a board-scanning instrument, which is minutes; thirty sessions is
    // enough for the property (the score moves with the dial) and the bin
    // `run-ranking` sweeps five settings over both corpora in full.
    let whole = suite();
    let suite = Suite {
        version: whole.version,
        today: whole.today.clone(),
        handles: whole.handles.clone(),
        sessions: whole.sessions.iter().take(30).cloned().collect(),
    };
    let fallback = nulls::Keyword::both();
    let mut seen: Vec<(f64, f64, f64)> = Vec::new();
    for p in [0.5_f64, 0.9] {
        let runtime =
            crate::degraded::DegradedReference::new(&Reference, &fallback, p, 0x5eed_0f13);
        let report = run(&suite, template(), &runtime).expect("the run finishes");
        let (passed, total) = report.strict_sessions();
        #[expect(clippy::cast_precision_loss, reason = "a rate over tens of sessions")]
        let strict = passed as f64 / total as f64;
        seen.push((p, strict, report.graded_score()));
    }
    let (low_p, low_strict, low_graded) = seen[0];
    let (high_p, high_strict, high_graded) = seen[1];
    assert!(
        low_strict < high_strict && low_graded < high_graded,
        "the score does not rank: p={low_p} scored {low_strict:.3}/{low_graded:.3} and \
         p={high_p} scored {high_strict:.3}/{high_graded:.3}"
    );
    assert!(
        high_strict < 1.0,
        "a candidate right 9 times in 10 must not pass everything"
    );
}
