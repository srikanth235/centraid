//! The proofs of the training-data coverage work, as fast tests: fields as a balanced dimension, the intents of the Locker's
//! typed secrets, measurements and the options of `find`, the oversampling of rare outcomes at the source and the ceilings.
//! Each intent family is built by the sampler, solved through the real runtime and shown to carry its argument in the
//! reference call; the oversampling and ceilings are counts over what the sampler draws.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::brief::Briefer;
use crate::catalog::Catalog;
use crate::facts::Facts;
use crate::fields;
use crate::grid::{Cell, Grid, Live, cell_of};
use crate::intent::{Intent, Outcome, Scenario, TurnIntent};
use crate::labels;
use crate::messages::{Job, no_sealed, writer_prompt};
use crate::plan::{Solution, WorldRun, call_xml};
use crate::rng::Rng;
use crate::run::draws;
use crate::sample::{Aim, Room, Sampler, Search};
use crate::settings::{Settings, Split};
use crate::style::Style;
use crate::verify;
use crate::world::{World, WorldSpec, plan_sized};

fn catalog() -> Catalog {
    Catalog::build().expect("catalog")
}

/// Train worlds of the first presets, with more rows in the trash than a preset puts there: a read of the trash needs some.
fn worlds(split: Split, n: usize) -> Vec<World> {
    plan_sized(1, |s| if s == split { n } else { 0 })
        .into_iter()
        .map(|spec: WorldSpec| {
            let mut settings =
                Settings::for_world(spec.index, &mut Rng::new(spec.seed).fork("settings"));
            settings.trashed = settings.trashed.max(0.5);
            World::generate_with(spec, settings)
        })
        .collect()
}

/// A session drawn from `cell` aimed as `aim` says, in the first of `worlds` that gives one.
fn drawn(
    catalog: &Catalog,
    grid: &Grid,
    world: &World,
    cell: &Cell,
    aim: &Aim,
    seed: &str,
) -> Option<Scenario> {
    let facts = Facts::of(world, catalog);
    let sampler = Sampler::new(world, &facts, catalog, grid);
    let root = Rng::new(7).fork(seed);
    (0..40).find_map(|attempt| {
        let mut rng = root.fork(&format!("try:{attempt}"));
        sampler.session_aim("proof", cell, aim, &Room::default(), 1, &mut rng)
    })
}

fn aim_field(field: &str) -> Aim {
    Aim {
        field: Some(field.to_owned()),
        ..Aim::default()
    }
}

fn solve(run: &mut WorldRun<'_>, scenario: &Scenario) -> Solution {
    run.solve(scenario).expect("the vault opens")
}

/// The reference calls of every kept turn: `(tool, args)`.
fn calls(solution: &Solution) -> Vec<(String, Value)> {
    solution
        .record
        .as_ref()
        .and_then(|r| r["turns"].as_array())
        .into_iter()
        .flatten()
        .flat_map(|t| t["ref"].as_array().cloned().unwrap_or_default())
        // a repair turn's first call is one the runtime refuses: the call that does the work is the other
        .filter(|c| c["bad"] != true)
        .map(|c| {
            (
                c["tool"].as_str().unwrap_or_default().to_owned(),
                c["args"].clone(),
            )
        })
        .collect()
}

fn arg_lines(call: &Value) -> String {
    call["args"].as_str().unwrap_or_default().to_owned()
}

fn turn_of(scenario: &Scenario, tool: &str) -> TurnIntent {
    scenario
        .turns
        .iter()
        .find(|t| cell_of(t).tool == tool)
        .unwrap_or_else(|| panic!("no {tool} turn in {scenario:?}"))
        .clone()
}

// ------------------------------------------------------------------ A1: fields are a balanced dimension

#[test]
fn the_pairs_come_from_the_runtime_and_the_not_live_ones_say_why() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let pairs = fields::pairs(&catalog, &grid);
    let live = fields::live_labels(&catalog, &grid);
    for must in [
        "create/task/priority",
        "create/task/date",
        "create/locker item/password",
        "create/locker item/card_number",
        "create/workout/distance",
        "edit/person/nickname",
        "edit/locker item/password",
        "edit/workout/moving",
        "edit/task/status",
        "edit/list/area",
    ] {
        assert!(live.contains(&must.to_owned()), "{must} is not live");
    }
    // a pair the runtime refuses or ignores is not live, and says so
    for (label, why) in [
        ("edit/transaction/amount", "cannot be edited"),
        ("edit/account/opening", "cannot be edited"),
        ("create/account/opening", "money field"),
        ("create/transaction/amount", "money field"),
        ("create/task/list", "`#n`"),
        ("create/workout/end", "reads no"),
        ("edit/daily figure/value", "Health store"),
    ] {
        match pairs.get(label) {
            Some(Live::NotLive(reason)) => assert!(reason.contains(why), "{label}: {reason}"),
            other => panic!("{label}: {other:?}"),
        }
    }
    // no money field is live for either tool
    assert!(
        live.iter()
            .all(|l| !l.ends_with("/amount") && !l.ends_with("/opening"))
    );
}

#[test]
fn every_live_pair_of_create_and_of_edit_is_drawn_and_the_turn_carries_it() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let live = fields::live_labels(&catalog, &grid);
    let worlds = worlds(Split::Train, 3);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for label in &live {
        let (verb, kind, field) = fields::split(label).expect("a label");
        let cell = Cell::new(verb, kind, verb);
        let aim = aim_field(field);
        for (i, world) in worlds.iter().enumerate() {
            let Some(scenario) =
                drawn(&catalog, &grid, world, &cell, &aim, &format!("{label}:{i}"))
            else {
                continue;
            };
            let carried: Vec<String> = scenario.turns.iter().flat_map(fields::of_turn).collect();
            assert!(
                carried.contains(label),
                "{label}: drawn turns carry {carried:?}"
            );
            seen.insert(label.clone());
            break;
        }
    }
    let missed: Vec<&String> = live.iter().filter(|l| !seen.contains(*l)).collect();
    assert!(missed.is_empty(), "live pairs never drawn: {missed:?}");
    // create and edit are both in the set
    assert!(seen.iter().any(|l| l.starts_with("create/")));
    assert!(seen.iter().any(|l| l.starts_with("edit/")));
}

// ------------------------------------------------------------------ A2: the Locker's typed secrets

#[test]
fn a_typed_locker_secret_is_drawn_solved_through_the_runtime_and_carried_by_the_call() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let world = worlds(Split::Train, 1).remove(0);
    let scratch = tempfile::tempdir().expect("scratch");
    let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
    let typed = crate::pools::typed(Split::Train);
    for (verb, field, pool) in [
        ("create", "password", typed.passwords),
        ("create", "card_number", typed.card_numbers),
        ("create", "cvv", typed.cvvs),
        ("create", "code", typed.codes),
        ("create", "notes", typed.notes),
        ("edit", "password", typed.passwords),
        ("edit", "card_number", typed.card_numbers),
        ("edit", "cvv", typed.cvvs),
    ] {
        let cell = Cell::new(verb, "locker item", verb);
        // a draw that is a secret note is the one that carries `notes` sealed
        let scenario = (0..30)
            .find_map(|i| {
                let s = drawn(
                    &catalog,
                    &grid,
                    &world,
                    &cell,
                    &aim_field(field),
                    &format!("lk:{verb}:{field}:{i}"),
                )?;
                let carries = s.turns.iter().any(|t| match &t.intent {
                    Intent::Create { fields, .. }
                    | Intent::Edit {
                        changes: fields, ..
                    } => fields.iter().any(|c| {
                        c.field == field
                            && (field != "notes"
                                || fields
                                    .iter()
                                    .any(|d| d.field == "type" && d.value.render() == "note"))
                    }),
                    _ => false,
                });
                carries.then_some(s)
            })
            .unwrap_or_else(|| panic!("no draw for {verb} {field}"));
        let solution = solve(&mut run, &scenario);
        assert!(
            solution.dropped.is_empty() && solution.kept == scenario.turns.len(),
            "{verb} {field}: {:?}",
            solution.dropped
        );
        let made = calls(&solution)
            .into_iter()
            .find(|(tool, args)| tool == verb && arg_lines(args).contains(&format!("{field}: ")))
            .unwrap_or_else(|| panic!("{verb} {field}: no call carries it"));
        let value = arg_lines(&made.1)
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{field}: ")).map(str::to_owned))
            .expect("the value");
        assert!(
            pool.contains(&value.as_str()),
            "{field}: `{value}` is not from the split's pool"
        );
        // gold records that a secret was set, never the value
        let gold = solution.record.as_ref().expect("a record")["turns"].to_string();
        assert!(!gold.contains("placeholder:"), "{gold}");
        let gold_of_turn = solution.record.as_ref().unwrap()["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["gold"].to_string())
            .collect::<Vec<_>>()
            .join("");
        assert!(
            !gold_of_turn.contains(&value),
            "{field}: the gold holds the typed value"
        );
    }
}

#[test]
fn a_typed_secret_is_a_verbatim_span_of_its_brief_and_a_placeholder_is_still_refused() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let world = worlds(Split::Train, 1).remove(0);
    let cell = Cell::new("create", "locker item", "create");
    let scenario = (0..30)
        .find_map(|i| {
            drawn(
                &catalog,
                &grid,
                &world,
                &cell,
                &aim_field("password"),
                &format!("brief:{i}"),
            )
        })
        .expect("a draw");
    let today = world.today.parse().expect("a date");
    let briefer = Briefer {
        catalog: &catalog,
        today,
    };
    let brief = briefer.turn(&scenario.turns[0], 0);
    let value = brief
        .typed
        .first()
        .expect("the brief names the typed secret")
        .clone();
    assert!(value.starts_with("fake-"), "{value}");
    assert!(brief.spans.contains(&value), "{:?}", brief.spans);
    assert!(brief.ask.contains(&value));
    // the writer is told the one exception, and only for a turn that types one
    let job = Job {
        id: "s".into(),
        today,
        briefs: vec![brief.clone()],
        style: Style::Dictated,
        test: false,
    };
    let prompt = writer_prompt(&[&job], 0);
    assert!(prompt.contains(&value) && prompt.contains("typed_secret"));
    assert!(
        no_sealed(&prompt).is_ok(),
        "a typed synthetic secret is no sealed value"
    );
    let plain = Job {
        briefs: vec![briefer.turn(&crate::proofs::plain_turn(&catalog, &grid, &world), 0)],
        ..job.clone()
    };
    let prompt = writer_prompt(&[&plain], 0);
    assert!(!prompt.contains("typed_secret") && !prompt.contains("The one exception"));
    // a placeholder is still refused, in a prompt and in a message
    assert!(no_sealed(&format!("{prompt}\npassword placeholder:k0:password")).is_err());
    let with_placeholder = Job {
        briefs: vec![crate::brief::TurnBrief {
            spans: vec!["placeholder:k0:password".into()],
            ..brief
        }],
        ..job
    };
    assert!(no_sealed(&writer_prompt(&[&with_placeholder], 0)).is_err());
    // and the reader is asked about the typed value only when a batch has one
    let expected = verify::expected(&catalog, &scenario.turns[0], today);
    assert_eq!(expected.typed, vec![value.clone()]);
    let batch = vec![(
        "s1".to_owned(),
        today,
        vec![format!("new password {value}")],
    )];
    assert!(verify::reader_prompt(&catalog, &batch, 0, true).contains("\"typed\""));
    assert!(!verify::reader_prompt(&catalog, &batch, 0, false).contains("\"typed\""));
    let read = verify::parse_reads(
        &serde_json::json!({"sessions": [{"id": "s1", "turns": [{"act": "create", "kind": "locker item", "typed": [value.to_uppercase()]}]}]}).to_string(),
        &[1],
    )
    .expect("reads")[0]
        .clone()
        .expect("a read");
    let slots = verify::slots(&catalog, &expected, &read[0], 0);
    assert!(slots.iter().any(|s| s.name == "typed" && s.ok), "{slots:?}");
}

/// A turn that types no secret, for the prompt that must not mention one.
pub(crate) fn plain_turn(catalog: &Catalog, grid: &Grid, world: &World) -> TurnIntent {
    let cell = Cell::new("find", "task", "read");
    drawn(catalog, grid, world, &cell, &Aim::default(), "plain")
        .expect("a read")
        .turns
        .remove(0)
}

// ------------------------------------------------------------------ A2: measurements

#[test]
fn a_measurement_is_made_and_changed_through_the_runtime_and_the_brief_says_its_unit() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let world = worlds(Split::Train, 1).remove(0);
    let scratch = tempfile::tempdir().expect("scratch");
    let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
    // a workout a member logs: a figure and its unit
    let create = Cell::new("create", "workout", "create");
    let scenario = drawn(
        &catalog,
        &grid,
        &world,
        &create,
        &aim_field("distance"),
        "m:create",
    )
    .expect("a draw");
    let solution = solve(&mut run, &scenario);
    assert!(solution.dropped.is_empty(), "{:?}", solution.dropped);
    let call = calls(&solution)
        .into_iter()
        .find(|(t, _)| t == "create")
        .expect("a create");
    assert!(arg_lines(&call.1).contains("distance: "), "{}", call.1);
    let today = world.today.parse().expect("a date");
    let brief = Briefer {
        catalog: &catalog,
        today,
    }
    .turn(&turn_of(&scenario, "create"), 0);
    assert!(
        brief.ask.contains("distance to ") && brief.ask.contains("(m)"),
        "{}",
        brief.ask
    );
    let want = verify::expected(&catalog, &turn_of(&scenario, "create"), today);
    assert!(
        !want.numbers.is_empty(),
        "the reader is asked for the number in base units"
    );
    // a figure the member changes on a workout they logged (a followed store states every other)
    let edit = Cell::new("edit", "workout", "edit");
    let scenario = drawn(
        &catalog,
        &grid,
        &world,
        &edit,
        &aim_field("moving"),
        "m:edit",
    )
    .expect("a draw");
    assert_eq!(scenario.turns.len(), 2);
    assert_eq!(
        cell_of(&scenario.turns[0]).to_string(),
        "create/workout/create"
    );
    let solution = solve(&mut run, &scenario);
    assert!(
        solution.dropped.is_empty() && solution.kept == 2,
        "{:?}",
        solution.dropped
    );
    let call = calls(&solution)
        .into_iter()
        .find(|(t, _)| t == "edit")
        .expect("an edit");
    assert!(arg_lines(&call.1).starts_with("moving: "), "{}", call.1);
}

// ------------------------------------------------------------------ A2: money

#[test]
fn no_money_amount_is_live_because_the_runtime_drops_or_refuses_it() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let world = worlds(Split::Train, 1).remove(0);
    let scratch = tempfile::tempdir().expect("scratch");
    let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
    let call = |live: &mut crate::plan::Live, tool: &str, args: &[(&str, &str)]| {
        let mut map = serde_json::Map::new();
        for (k, v) in args {
            map.insert((*k).to_owned(), Value::String((*v).to_owned()));
        }
        live.session.call_text(&call_xml(tool, &map))
    };
    // a new account is made without its opening balance: the runtime drops the argument
    let mut live = run.open().expect("opens");
    live.session.user("new account");
    let made = call(
        &mut live,
        "create",
        &[
            ("kind", "account"),
            ("args", "name: Rainy day\ntype: savings\nopening: 500"),
        ],
    );
    assert_eq!(
        made["effect"]["normalized"][0]["rule"], "create_arg_dropped",
        "{made}"
    );
    assert_eq!(
        made["effect"]["diff"]["rows"][0]["fields"]["opening"][1]["amount"],
        0.0
    );
    // a transaction is not created in chat
    let mut live = run.open().expect("opens");
    live.session.user("new transaction");
    let made = call(
        &mut live,
        "create",
        &[
            ("kind", "transaction"),
            ("args", "name: Coffee\namount: -4"),
        ],
    );
    assert!(
        made["effect"]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("create needs the kind")
    );
    // a money field is not edited
    let mut live = run.open().expect("opens");
    live.session.user("change it");
    let found = call(&mut live, "find", &[("kind", "account")]);
    assert!(found["effect"]["result"].is_string());
    let edited = call(
        &mut live,
        "edit",
        &[("rows", "#1"), ("args", "opening: 900")],
    );
    assert!(edited["effect"].get("error").is_some(), "{edited}");
    // so none is a live pair, and no sampler draws one
    let live = fields::live_labels(&catalog, &grid);
    assert!(
        live.iter()
            .all(|l| !l.ends_with("/amount") && !l.ends_with("/opening"))
    );
}

// ------------------------------------------------------------------ A2: the options of `find`

#[test]
fn each_option_of_find_a_plain_draw_never_used_is_drawn_solved_and_carried_by_the_call() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let world = worlds(Split::Train, 1).remove(0);
    let scratch = tempfile::tempdir().expect("scratch");
    let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
    for (search, kind, arg) in [
        (Search::Text, "task", "text"),
        (Search::Not, "task", "where"),
        (Search::Trashed, "task", "trashed"),
    ] {
        let aim = Aim {
            search: Some(search),
            ..Aim::default()
        };
        let mut solved = None;
        'draw: for kind_try in [kind, "note", "person", "event", "document", "photo"] {
            let cell = Cell::new("find", kind_try, "read");
            for i in 0..12 {
                let Some(scenario) = drawn(
                    &catalog,
                    &grid,
                    &world,
                    &cell,
                    &aim,
                    &format!("s:{arg}:{kind_try}:{i}"),
                ) else {
                    continue;
                };
                let solution = solve(&mut run, &scenario);
                if solution.dropped.is_empty() && solution.kept == scenario.turns.len() {
                    solved = Some((scenario, solution));
                    break 'draw;
                }
            }
        }
        let (scenario, solution) = solved.unwrap_or_else(|| panic!("no {search:?} read solved"));
        let found = calls(&solution)
            .into_iter()
            .find(|(t, a)| t == "find" && a.get(arg).is_some())
            .unwrap_or_else(|| panic!("{search:?}: no find carries {arg}: {:?}", calls(&solution)));
        match search {
            Search::Text => assert!(found.1["text"].as_str().is_some_and(|t| !t.is_empty())),
            Search::Not => assert!(
                found.1["where"]
                    .as_str()
                    .unwrap_or_default()
                    .contains(" != ")
            ),
            Search::Trashed => assert_eq!(found.1["trashed"], "true"),
        }
        // the brief says it and the reader is asked for what it means
        let today = world.today.parse().expect("a date");
        let turn = &scenario.turns[0];
        let brief = Briefer {
            catalog: &catalog,
            today,
        }
        .turn(turn, 0);
        match search {
            Search::Text => assert!(brief.ask.contains("searching") && !brief.spans.is_empty()),
            Search::Not => assert!(brief.ask.contains("is not")),
            Search::Trashed => assert!(brief.ask.contains("in the trash")),
        }
        let want = verify::expected(&catalog, turn, today);
        match search {
            Search::Text => assert!(!want.names.is_empty()),
            Search::Not => assert!(!want.excluding.is_empty()),
            Search::Trashed => {}
        }
    }
}

// ------------------------------------------------------------------ A3 and A4: the sampler's supply and ceilings

/// What one sweep of the draws gives over `worlds`: every turn drawn, before any is solved.
fn sweep(catalog: &Catalog, grid: &Grid, worlds: &[World], room: &Room) -> Vec<TurnIntent> {
    let order = draws(catalog, grid);
    let mut out = Vec::new();
    for world in worlds {
        let facts = Facts::of(world, catalog);
        let sampler = Sampler::new(world, &facts, catalog, grid);
        let root = Rng::new(3).fork(&world.id());
        for (n, draw) in order.iter().enumerate() {
            let mut shape = root.fork(&format!("shape:{n}"));
            let extra = *shape.weighted(&[(0, 26), (1, 32), (2, 22), (3, 20)]);
            let mut rng = root.fork(&format!("draw:{n}"));
            if let Some(scenario) =
                sampler.session_aim("s", &draw.cell, &draw.aim, room, extra, &mut rng)
            {
                out.extend(scenario.turns);
            }
        }
    }
    out
}

#[test]
fn the_rare_outcomes_are_oversampled_at_the_source_to_at_least_their_target_share() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let worlds = worlds(Split::Train, 3);
    let turns = sweep(&catalog, &grid, &worlds, &Room::default());
    let all = turns.len();
    let count = |f: &dyn Fn(&TurnIntent) -> bool| turns.iter().filter(|t| f(t)).count();
    let targets = crate::mix::Shares::default();
    let empty = count(&|t| t.outcome == Outcome::Empty);
    let ask = count(&|t| t.outcome == Outcome::Ask);
    let decline = count(&|t| t.outcome == Outcome::Decline);
    let impossible = count(&|t| labels::impossible(t));
    let pointing = count(&|t| !labels::reference(t).is_empty());
    let nickname = count(&|t| labels::reference(t) == "nickname");
    // the shares the mix aims at are in turns; the supply has to hold at least that many of each
    println!(
        "drawn {all}: nothing found {empty}, ask {ask}, decline {decline}, impossible {impossible}, nickname {nickname} of {pointing}"
    );
    assert!(
        empty as f64 >= targets.outcome[1] * all as f64,
        "nothing found {empty} of {all}"
    );
    assert!(
        ask as f64 >= targets.outcome[2] * all as f64,
        "ask {ask} of {all}"
    );
    assert!(
        decline as f64 >= targets.outcome[3] * all as f64,
        "decline {decline} of {all}"
    );
    assert!(
        impossible as f64 >= targets.impossible * all as f64,
        "impossible {impossible} of {all}"
    );
    assert!(
        nickname as f64 >= targets.reference[3] * pointing as f64,
        "nickname {nickname} of {pointing} turns that point at a row"
    );
}

#[test]
fn a_run_with_no_room_for_a_share_draws_none_of_it() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let worlds = worlds(Split::Train, 2);
    let none = Room {
        pronoun: false,
        undo: false,
    };
    let turns = sweep(&catalog, &grid, &worlds, &none);
    assert!(!turns.is_empty());
    // the one pronoun turn left is the edit of a workout the session logged, which a member can only do that way and which
    // the field floor needs; the mix's ceiling holds the share
    for t in turns.iter().filter(|t| labels::reference(t) == "pronoun") {
        assert!(
            matches!(&t.intent, Intent::Edit { target: crate::intent::Target::Turn { kind, .. }, .. } if kind == "workout"),
            "{t:?}"
        );
    }
    assert_eq!(
        turns
            .iter()
            .filter(|t| cell_of(t).to_string() == "do/-/undo")
            .count(),
        0
    );
    // and with room they are drawn
    let some = sweep(&catalog, &grid, &worlds, &Room::default());
    assert!(count_labels(&some, "pronoun") > 0);
    assert!(some.iter().any(|t| cell_of(t).to_string() == "do/-/undo"));
}

fn count_labels(turns: &[TurnIntent], label: &str) -> usize {
    turns
        .iter()
        .filter(|t| labels::reference(t) == label)
        .count()
}

#[test]
fn the_cells_the_draws_name_are_all_live() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let order = draws(&catalog, &grid);
    let mut aimed: BTreeMap<&str, usize> = BTreeMap::new();
    for draw in &order {
        assert!(grid.is_live(&draw.cell), "{}", draw.cell);
        let kind = match (
            &draw.aim.field,
            draw.aim.empty,
            draw.aim.nickname,
            draw.aim.search,
        ) {
            (Some(_), ..) => "field",
            (_, true, ..) => "empty",
            (_, _, true, _) => "nickname",
            (_, _, _, Some(_)) => "search",
            _ => "plain",
        };
        *aimed.entry(kind).or_default() += 1;
    }
    for kind in ["field", "empty", "nickname", "search", "plain"] {
        assert!(
            aimed.get(kind).copied().unwrap_or(0) > 0,
            "{kind}: {aimed:?}"
        );
    }
}
