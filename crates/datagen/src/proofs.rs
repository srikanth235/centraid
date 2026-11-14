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
    assert!(
        verify::reader_prompt(
            &catalog,
            &batch,
            0,
            verify::Asks {
                typed: true,
                presence: false
            }
        )
        .contains("\"typed\"")
    );
    assert!(
        !verify::reader_prompt(&catalog, &batch, 0, verify::Asks::default()).contains("\"typed\"")
    );
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

/// What the brief and the read-back say about the turn that carries an option of `find`.
struct Said<'a> {
    /// The turns of the scenario, and the calls the runtime ran for them.
    scenario: &'a Scenario,
    catalog: &'a Catalog,
    today: jiff::civil::Date,
}

impl Said<'_> {
    fn brief(&self, turn: usize) -> crate::brief::TurnBrief {
        Briefer {
            catalog: self.catalog,
            today: self.today,
        }
        .turn(&self.scenario.turns[turn], turn)
    }

    fn want(&self, turn: usize) -> verify::Expected {
        verify::expected(self.catalog, &self.scenario.turns[turn], self.today)
    }
}

/// Draw `search` for a read of one of `kinds` in the first of three train worlds that gives one the runtime solves as the
/// index says, and hand the scenario and the reference calls of the whole session to `check`.
fn prove(
    search: Search,
    kinds: &[&str],
    check: impl Fn(&Said<'_>, &[(String, Value)]) -> bool,
    what: &str,
) {
    prove_in(("find", "read"), search, kinds, check, what);
}

/// [`prove`] for the cell `(tool, verb)` of each of `kinds`: a count or a total through an option of `compute`.
fn prove_in(
    (tool, verb): (&str, &str),
    search: Search,
    kinds: &[&str],
    check: impl Fn(&Said<'_>, &[(String, Value)]) -> bool,
    what: &str,
) {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let aim = Aim {
        search: Some(search),
        ..Aim::default()
    };
    for world in worlds(Split::Train, 3) {
        let scratch = tempfile::tempdir().expect("scratch");
        let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
        for kind in kinds {
            let cell = Cell::new(tool, kind, verb);
            for i in 0..16 {
                let Some(scenario) = drawn(
                    &catalog,
                    &grid,
                    &world,
                    &cell,
                    &aim,
                    &format!("s:{search:?}:{kind}:{i}"),
                ) else {
                    continue;
                };
                let solution = solve(&mut run, &scenario);
                if !solution.dropped.is_empty() || solution.kept != scenario.turns.len() {
                    continue;
                }
                let said = Said {
                    scenario: &scenario,
                    catalog: &catalog,
                    today: world.today.parse().expect("a date"),
                };
                let made = calls(&solution);
                if check(&said, &made) {
                    return;
                }
            }
        }
    }
    panic!(
        "no {search:?} turn of {tool}/{verb} was drawn, solved through the runtime and carried by the call ({what})"
    );
}

fn find_with<'a>(made: &'a [(String, Value)], arg: &'a str) -> impl Iterator<Item = &'a Value> {
    made.iter()
        .filter(move |(tool, args)| tool == "find" && args.get(arg).is_some())
        .map(|(_, args)| args)
}

fn where_of(args: &Value) -> String {
    args["where"].as_str().unwrap_or_default().to_owned()
}

fn when_of(args: &Value) -> Value {
    serde_json::from_str(args["when"].as_str().unwrap_or_default()).unwrap_or(Value::Null)
}

#[test]
fn a_text_search_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Text,
        &["task", "note", "person", "event", "document"],
        |said, made| {
            find_with(made, "text").any(|a| a["text"].as_str().is_some_and(|t| !t.is_empty()))
                && said.brief(0).ask.contains("searching")
                && !said.want(0).names.is_empty()
        },
        "text",
    );
}

#[test]
fn a_read_of_the_trash_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Trashed,
        &["task", "note", "person", "event", "document", "photo"],
        |said, made| {
            find_with(made, "trashed").any(|a| a["trashed"] == "true")
                && said.brief(0).ask.contains("in the trash")
        },
        "trashed",
    );
}

#[test]
fn a_field_that_is_not_a_value_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Not,
        &["task", "transaction", "account", "locker item"],
        |said, made| {
            find_with(made, "where").any(|a| where_of(a).contains(" != "))
                && said.brief(0).ask.contains("is not")
                && !said.want(0).excluding.is_empty()
        },
        "!=",
    );
}

#[test]
fn a_field_that_is_one_of_some_values_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::In,
        &["task", "transaction", "account", "locker item", "workout"],
        |said, made| {
            find_with(made, "where").any(|a| {
                let clause = where_of(a);
                clause.contains(" in (\"") && clause.matches('"').count() >= 4
            }) && said.brief(0).ask.contains("any one of them")
                && said.want(0).filters.len() >= 2
        },
        "in",
    );
}

#[test]
fn a_field_that_is_empty_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Empty,
        &["person", "task", "locker item", "workout", "event"],
        |said, made| {
            find_with(made, "where").any(|a| where_of(a).contains(" is empty"))
                && said.brief(0).ask.contains("is empty")
                && said.want(0).presence.iter().any(|(_, v)| v == "empty")
        },
        "is empty",
    );
}

#[test]
fn a_field_that_is_set_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Set,
        &["person", "task", "locker item", "workout", "event"],
        |said, made| {
            find_with(made, "where").any(|a| where_of(a).contains(" is set"))
                && said.brief(0).ask.contains("filled in")
                && said.want(0).presence.iter().any(|(_, v)| v == "set")
        },
        "is set",
    );
}

#[test]
fn a_row_opened_by_its_handle_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Rows,
        &["task", "person", "event", "note", "document", "list"],
        |said, made| {
            // a find by name, then the find that opens the row it found
            find_with(made, "rows").any(|a| a["rows"].as_str().is_some_and(|r| r.starts_with('#')))
                && find_with(made, "name").next().is_some()
                && said.brief(0).ask.contains("everything about")
                && !said.want(0).names.is_empty()
        },
        "rows",
    );
}

#[test]
fn the_rows_an_earlier_read_did_not_show_are_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Exclude,
        &["task", "person", "event", "note", "document", "photo"],
        |said, made| {
            find_with(made, "exclude")
                .any(|a| a["exclude"].as_str().is_some_and(|r| r.starts_with('@')))
                && said.scenario.turns.len() >= 2
                && said.scenario.turns[1].dep == Some((0, crate::intent::Dep::Else))
                && said.brief(1).how.contains("asks for the others")
                && said.want(1).leaves_out_rows
        },
        "exclude",
    );
}

#[test]
fn a_comma_list_of_kinds_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Kinds,
        &["task", "event", "note", "transaction", "document", "photo"],
        |said, made| {
            find_with(made, "kind").any(|a| a["kind"].as_str().is_some_and(|k| k.contains(", ")))
                && find_with(made, "when").next().is_some()
                && said.brief(0).ask.contains(" and the ")
                && !said.want(0).also.is_empty()
                && !said.scenario.turns[0].apps.is_empty()
        },
        "a comma list of kinds",
    );
}

#[test]
fn a_weekday_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Weekday,
        &["task", "event", "note", "transaction", "document", "photo"],
        |said, made| {
            find_with(made, "when").any(|a| {
                let when = when_of(a);
                when["unit"] == "week" && when["weekday"].is_i64()
            }) && said.want(0).period.is_some_and(|(from, to)| from == to)
                && [
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday",
                ]
                .iter()
                .any(|day| said.brief(0).ask.contains(day))
        },
        "a weekday",
    );
}

#[test]
fn a_month_by_name_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::MonthName,
        &["task", "event", "note", "transaction", "document", "photo"],
        |said, made| {
            find_with(made, "when").any(|a| {
                let when = when_of(a);
                when["unit"] == "month" && when["name"].is_i64()
            }) && said.want(0).period.is_some_and(|(from, to)| from < to)
        },
        "a month by name",
    );
}

#[test]
fn a_time_of_day_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Clock,
        &["event"],
        |said, made| {
            find_with(made, "when").any(|a| {
                let when = when_of(a);
                when["unit"] == "day" && when["time"].as_str().is_some_and(|t| t.len() == 5)
            }) && said.want(0).period.is_some_and(|(from, to)| from == to)
                && said.brief(0).ask.contains(" at ")
        },
        "a time of day",
    );
}

#[test]
fn a_period_with_an_open_end_is_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Open,
        &["task", "event", "note", "transaction", "document", "photo"],
        |said, made| {
            find_with(made, "when").any(|a| {
                let when = when_of(a);
                when.get("from").is_some() != when.get("to").is_some()
            }) && said.want(0).open.is_some()
                && said.want(0).period.is_none()
                && (said.brief(0).ask.contains("on or after")
                    || said.brief(0).ask.contains("on or before"))
        },
        "an open end",
    );
}

#[test]
fn a_period_says_what_the_runtime_reads_and_never_a_day_of_a_week_as_the_week() {
    use crate::intent::Period;
    let today: jiff::civil::Date = "2026-09-16".parse().expect("a Wednesday");
    let range = |when: &str| {
        Period::parse_when(when)
            .expect("a period the sampler draws")
            .range(today)
            .map(|(a, b)| (a.to_string(), b.to_string()))
    };
    let some = |a: &str, b: &str| Some((a.to_owned(), b.to_owned()));
    // a day of last week, not the week
    assert_eq!(
        range(r#"{"unit":"week","rel":-1,"weekday":5}"#),
        some("2026-09-11", "2026-09-11")
    );
    assert_eq!(
        range(r#"{"unit":"week","rel":0}"#),
        some("2026-09-14", "2026-09-20")
    );
    // the runtime's named month: the latest one that has ended, the next one that has not begun, this year's
    assert_eq!(
        range(r#"{"unit":"month","name":3,"rel":-1}"#),
        some("2026-03-01", "2026-03-31")
    );
    assert_eq!(
        range(r#"{"unit":"month","name":9,"rel":-1}"#),
        some("2025-09-01", "2025-09-30")
    );
    assert_eq!(
        range(r#"{"unit":"month","name":2,"rel":1}"#),
        some("2027-02-01", "2027-02-28")
    );
    assert_eq!(
        range(r#"{"unit":"month","name":11,"rel":0}"#),
        some("2026-11-01", "2026-11-30")
    );
    // a time of day keeps its day, and an end left open is the calendar's own limit
    assert_eq!(
        range(r#"{"unit":"day","rel":2,"time":"15:00"}"#),
        some("2026-09-18", "2026-09-18")
    );
    let (from, to) = Period::parse_when(r#"{"from":{"unit":"day","rel":-3}}"#)
        .expect("open")
        .range(today)
        .expect("a range");
    assert_eq!(from.to_string(), "2026-09-13");
    assert_eq!(to, jiff::civil::Date::MAX);
    assert_eq!(
        range(r#"{"to":{"date":"2026-09-01"}}"#).map(|(a, _)| a),
        Some(jiff::civil::Date::MIN.to_string())
    );
    // and the forms are told apart, never one read as another
    for (text, period) in [
        (
            r#"{"unit":"week","rel":0,"weekday":3}"#,
            Period::Weekday { rel: 0, weekday: 3 },
        ),
        (
            r#"{"unit":"day","rel":1,"time":"09:30"}"#,
            Period::Clock {
                rel: 1,
                time: "09:30".into(),
            },
        ),
        (
            r#"{"unit":"month","name":2,"rel":-1}"#,
            Period::NamedMonth { rel: -1, name: 2 },
        ),
    ] {
        assert_eq!(Period::parse_when(text), Some(period.clone()));
        assert_eq!(Period::parse_when(&period.when()), Some(period));
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
        recall: false,
        undo: false,
    };
    let turns = sweep(&catalog, &grid, &worlds, &none);
    assert!(!turns.is_empty());
    // a workout the session logged is then edited by its name, which points at a row by no pronoun
    assert_eq!(count_labels(&turns, "pronoun"), 0);
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

// ------------------------------------------------------------------ the think of each new call

/// The think the renderer writes for `call`, round-tripped through the runtime's compiler, in a session that has shown
/// the rows `shown` (`#n type "name"` lines) and said `message`, with the `dates:` line `block`.
fn traced(
    tool: &str,
    args: &[(&str, &str)],
    message: &str,
    block: &str,
    shown: &[&str],
) -> Result<crate::trace::Traced, crate::trace::Failure> {
    use crate::trace::{RefCall, Setting, show_rows, trace};
    let mut rows = BTreeMap::new();
    for line in shown {
        show_rows(&mut rows, line);
    }
    let call = RefCall {
        tool: tool.to_owned(),
        args: args
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        bad: false,
    };
    let seen = shown.join("\n");
    trace(
        &call,
        &Setting {
            message,
            today: "2026-10-12".parse().expect("a date"),
            intent: "read",
            block,
            rows: &rows,
            earlier_dates: &[],
            seen: &seen,
            turn_kind: None,
            retry: false,
        },
    )
}

#[test]
fn the_think_of_a_call_with_each_new_option_compiles_back_to_the_call() {
    // `where` operators
    for (clause, said) in [
        (
            r#"status in ("completed", "cancelled")"#,
            "tasks that are done or dropped",
        ),
        (r#"role is empty"#, "people with no role"),
        (r#"role is set"#, "people that have a role"),
    ] {
        let kind = if clause.starts_with("status") {
            "task"
        } else {
            "person"
        };
        let made = traced("find", &[("kind", kind), ("where", clause)], said, "", &[])
            .unwrap_or_else(|why| panic!("{clause}: {why:?}"));
        assert_eq!(made.call.tool, "find", "{clause}");
    }
    // a comma list of kinds with a period the line reads
    let made = traced(
        "find",
        &[
            ("kind", "task, event"),
            ("when", r#"{"unit":"week","rel":0}"#),
        ],
        "what is on this week",
        "dates: this week = 2026-10-12..2026-10-18",
        &[],
    )
    .unwrap_or_else(|why| panic!("kinds: {why:?}"));
    assert!(
        made.think.contains("task, event") || made.think.contains("task,event"),
        "{}",
        made.think
    );
    // opening a row by the number the first find showed, and leaving out the rows an earlier turn showed
    traced(
        "find",
        &[("rows", "#22")],
        "everything about the dentist",
        "",
        &["#22 event \"Dentist\" · Tue 2026-10-13 09:00"],
    )
    .unwrap_or_else(|why| panic!("rows: {why:?}"));
    traced(
        "find",
        &[("kind", "task"), ("exclude", "@1")],
        "what else is there",
        "",
        &[],
    )
    .unwrap_or_else(|why| panic!("exclude: {why:?}"));
    // the forms of `when`, each as the member's words are read or, when the line reads none, as the compact date
    for (when, said, block) in [
        (
            r#"{"unit":"week","rel":-1,"weekday":5}"#,
            "tasks due last friday",
            "dates: last friday = 2026-10-09",
        ),
        (
            r#"{"unit":"month","name":3,"rel":-1}"#,
            "events in march",
            "dates: march = 2026-03-01..2026-03-31 (past) / 2027-03-01..2027-03-31 (upcoming)",
        ),
        (
            r#"{"unit":"day","rel":2,"time":"15:00"}"#,
            "what is at three on wednesday",
            "dates: wednesday at three = 2026-10-14 15:00",
        ),
        (
            r#"{"from":{"unit":"day","rel":-3}}"#,
            "tasks since friday",
            "dates: since friday = 2026-10-09..",
        ),
        (
            r#"{"to":{"date":"2026-09-01"}}"#,
            "tasks until september 1",
            "dates: until september 1 = ..2026-09-01",
        ),
    ] {
        let kind = if when.contains("3,") { "event" } else { "task" };
        traced("find", &[("kind", kind), ("when", when)], said, block, &[])
            .unwrap_or_else(|why| panic!("{when}: {why:?}"));
        // and with no line to read it from
        traced("find", &[("kind", kind), ("when", when)], said, "", &[])
            .unwrap_or_else(|why| panic!("{when} (compact): {why:?}"));
    }
}

// ------------------------------------------------------------------ the options of `compute`

#[test]
fn the_top_few_of_a_read_are_drawn_solved_and_carried_by_the_call() {
    prove(
        Search::Top,
        &["task", "workout", "event", "person", "transaction"],
        |said, made| {
            find_with(made, "order").any(|a| {
                a["limit"]
                    .as_str()
                    .is_some_and(|n| n.parse::<usize>().is_ok())
            }) && said.brief(0).ask.contains("sorted by")
                && said.brief(0).ask.contains("only the first")
                && !said.want(0).numbers.is_empty()
        },
        "order and limit",
    );
}

#[test]
fn a_total_over_the_top_few_is_drawn_solved_and_carried_by_the_call() {
    prove_in(
        ("compute", "sum"),
        Search::Top,
        &["task", "workout", "event", "person"],
        |said, made| {
            made.iter().any(|(tool, a)| {
                tool == "compute"
                    && a["op"] == "sum"
                    && a["order"]
                        .as_str()
                        .is_some_and(|o| o.ends_with(" desc") || o.ends_with(" asc"))
                    && a["limit"]
                        .as_str()
                        .is_some_and(|n| n.parse::<usize>().is_ok())
            }) && said.brief(0).ask.contains("sorted by")
                && said.brief(0).ask.contains("only the first")
        },
        "compute order and limit",
    );
}

#[test]
fn a_count_of_the_trash_is_drawn_solved_and_carried_by_the_call() {
    prove_in(
        ("compute", "count"),
        Search::Trashed,
        &["task", "note", "person", "event", "document", "photo"],
        |said, made| {
            made.iter()
                .any(|(tool, a)| tool == "compute" && a["trashed"] == "true")
                && said.brief(0).ask.contains("in the trash")
        },
        "compute trashed",
    );
}

#[test]
fn a_count_of_the_others_is_drawn_solved_and_carried_by_the_call() {
    prove_in(
        ("compute", "count"),
        Search::Exclude,
        &["task", "person", "event", "note", "document", "photo"],
        |said, made| {
            made.iter().any(|(tool, a)| {
                tool == "compute" && a["exclude"].as_str().is_some_and(|r| r.starts_with('@'))
            }) && said.scenario.turns.len() >= 2
                && said.scenario.turns[1].dep == Some((0, crate::intent::Dep::Else))
                && said.want(1).leaves_out_rows
        },
        "compute exclude",
    );
}

// ------------------------------------------------------------------ the rows a member logged are edited by name

#[test]
fn a_workout_the_member_logged_is_edited_by_its_name_with_every_figure() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let world = worlds(Split::Train, 1).remove(0);
    let scratch = tempfile::tempdir().expect("scratch");
    let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
    for field in ["moving", "distance", "energy", "heart_rate", "climb"] {
        let cell = Cell::new("edit", "workout", "edit");
        // with no room for a pronoun the edit can only name the workout
        let facts = Facts::of(&world, &catalog);
        let sampler = Sampler::new(&world, &facts, &catalog, &grid);
        let none = Room {
            pronoun: false,
            recall: false,
            undo: false,
        };
        let scenario = (0..20)
            .find_map(|i| {
                let mut rng = Rng::new(9).fork(&format!("{field}:{i}"));
                sampler.session_aim("proof", &cell, &aim_field(field), &none, 0, &mut rng)
            })
            .unwrap_or_else(|| panic!("{field}: no session"));
        assert_eq!(scenario.turns.len(), 2);
        let edit = &scenario.turns[1];
        assert_eq!(edit.reference, crate::intent::Reference::Name);
        assert!(edit.dep.is_none());
        assert!(matches!(
            &edit.intent,
            Intent::Edit { target: crate::intent::Target::Name { kind, .. }, .. } if kind == "workout"
        ));
        let solution = solve(&mut run, &scenario);
        assert!(
            solution.dropped.is_empty() && solution.kept == 2,
            "{field}: {:?}",
            solution.dropped
        );
        let made = calls(&solution);
        assert!(
            made.iter().any(|(t, a)| t == "edit"
                && arg_lines(&serde_json::json!({"args": a["args"]}))
                    .starts_with(&format!("{field}: "))),
            "{field}: {made:?}"
        );
        assert!(
            made.iter()
                .any(|(t, a)| t == "find" && a["name"].is_string())
        );
        assert_eq!(labels::reference(edit), "name");
    }
}

// ------------------------------------------------------------------ rare outcomes after another turn

/// A session of `cell` aimed as `tail` (a rare turn after an ordinary one), solved through the runtime in the first of four
/// worlds that gives one, with the tags of its turns.
fn tailed(cell: &Cell, aim: &Aim) -> Option<(Scenario, Solution, Vec<Vec<String>>)> {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    for world in worlds(Split::Train, 4) {
        let scratch = tempfile::tempdir().expect("scratch");
        let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
        let facts = Facts::of(&world, &catalog);
        let sampler =
            Sampler::new(&world, &facts, &catalog, &grid).with_empty_reads(run.empty_reads);
        for i in 0..24 {
            let mut rng = Rng::new(11).fork(&format!("{cell}:{i}"));
            let Some(scenario) =
                sampler.session_aim("proof", cell, aim, &Room::default(), 1, &mut rng)
            else {
                continue;
            };
            let solution = solve(&mut run, &scenario);
            if !solution.dropped.is_empty() || solution.kept != scenario.turns.len() {
                continue;
            }
            let tags = solution.record.as_ref()?["turns"]
                .as_array()?
                .iter()
                .map(|t| {
                    t["tags"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .collect();
            return Some((scenario, solution, tags));
        }
    }
    None
}

#[test]
fn ask_nothing_found_decline_and_impossible_occur_after_another_turn_solved_and_labelled() {
    let tail = Aim {
        tail: true,
        ..Aim::default()
    };
    let empty = Aim {
        tail: true,
        empty: true,
        ..Aim::default()
    };
    for (cell, aim, outcome, last_tool) in [
        (Cell::new("ask", "task", "ask"), &tail, "ask", "ask"),
        (Cell::new("ask", "person", "ask"), &tail, "ask", "ask"),
        (Cell::new("find", "task", "read"), &empty, "empty", "answer"),
        (
            Cell::new("compute", "task", "count"),
            &empty,
            "empty",
            "answer",
        ),
        (
            Cell::new("decline", "-", "not_found"),
            &tail,
            "decline",
            "decline",
        ),
        (
            Cell::new("decline", "-", "out_of_scope"),
            &tail,
            "decline",
            "decline",
        ),
        (
            Cell::new("decline", "-", "unbounded_destruction"),
            &tail,
            "decline",
            "decline",
        ),
        (
            Cell::new("decline", "-", "fabricated_secret"),
            &tail,
            "decline",
            "decline",
        ),
    ] {
        let (scenario, solution, tags) =
            tailed(&cell, aim).unwrap_or_else(|| panic!("{cell}: no session was drawn and solved"));
        let last = scenario.turns.len() - 1;
        assert!(last >= 1, "{cell}: a rare turn alone is not a later turn");
        // the rare turn is the second or later turn, leans on nothing and is labelled as it is
        let rare = &scenario.turns[last];
        assert!(rare.dep.is_none(), "{cell}");
        assert_eq!(rare.outcome.word(), outcome, "{cell}");
        assert!(
            tags[last].contains(&format!("outcome:{outcome}")),
            "{cell}: {tags:?}"
        );
        assert_eq!(cell_of(rare).to_string(), cell.to_string());
        // no earlier turn is a rare one
        assert!(
            scenario.turns[..last]
                .iter()
                .all(|t| !matches!(t.intent, Intent::Ask { .. } | Intent::Decline { .. }))
        );
        let ref_tools: Vec<String> =
            solution.record.as_ref().expect("a record")["turns"][last]["ref"]
                .as_array()
                .expect("calls")
                .iter()
                .filter_map(|c| c["tool"].as_str().map(str::to_owned))
                .collect();
        assert_eq!(
            ref_tools.last().map(String::as_str),
            Some(last_tool),
            "{cell}: {ref_tools:?}"
        );
        if cell.verb == "out_of_scope"
            || cell.verb == "unbounded_destruction"
            || cell.verb == "fabricated_secret"
        {
            assert!(labels::impossible(rare), "{cell}");
        }
        // an ask is of the kind of the cell, so no second kind comes in with it (a read that finds nothing may keep a link)
        if cell.tool == "ask" {
            assert!(
                labels::kinds(rare).iter().all(|k| *k == cell.kind),
                "{cell}"
            );
        }
    }
}

#[test]
fn a_row_is_deleted_and_restored_so_every_restore_cell_has_supply() {
    let catalog = catalog();
    let grid = Grid::build(&catalog);
    let world = worlds(Split::Train, 1).remove(0);
    let scratch = tempfile::tempdir().expect("scratch");
    let mut run = WorldRun::seed(&world, &catalog, scratch.path()).expect("seeds");
    let facts = Facts::of(&world, &catalog);
    let sampler = Sampler::new(&world, &facts, &catalog, &grid);
    for kind in ["document", "locker item"] {
        let cell = Cell::new("do", kind, "restore");
        assert!(grid.is_live(&cell), "{cell}");
        let aim = Aim {
            trash: true,
            ..Aim::default()
        };
        let scenario = (0..40)
            .find_map(|i| {
                let mut rng = Rng::new(5).fork(&format!("{kind}:{i}"));
                let scenario =
                    sampler.session_aim("proof", &cell, &aim, &Room::default(), 2, &mut rng)?;
                let solution = run.solve(&scenario).ok()?;
                (solution.dropped.is_empty() && solution.kept == 2).then_some((scenario, solution))
            })
            .unwrap_or_else(|| panic!("{kind}: no delete and restore was solved"));
        let (scenario, solution) = scenario;
        assert_eq!(scenario.turns.len(), 2);
        assert_eq!(
            cell_of(&scenario.turns[0]).to_string(),
            format!("do/{kind}/delete")
        );
        assert_eq!(cell_of(&scenario.turns[1]).to_string(), cell.to_string());
        let made = calls(&solution);
        assert!(
            made.iter().any(|(t, a)| t == "do" && a["verb"] == "delete"),
            "{made:?}"
        );
        assert!(
            made.iter()
                .any(|(t, a)| t == "do" && a["verb"] == "restore"),
            "{made:?}"
        );
        assert!(
            made.iter()
                .any(|(t, a)| t == "find" && a["trashed"] == "true"),
            "{made:?}"
        );
    }
}
