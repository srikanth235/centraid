//! Stage 1: worlds are pure functions of their spec, cover every kind, carry no sealed value and
//! seed into a vault the `centraid-assist` runtime reads back.

use std::collections::BTreeMap;

use centraid_datagen::ambiguity::measure;
use centraid_datagen::world::plan_sized;
use centraid_datagen::{Catalog, Settings, Split, World, plan};
use centraid_nativetools::{Flags, dates, vaultio};
use serde_json::{Value, json};

/// Seed-document section → catalog kind, for every kind the catalog has. A new kind with no row
/// here fails `every_kind_of_every_app_is_populated_in_some_world`.
const SECTIONS: &[(&str, &str)] = &[
    ("people", "person"),
    ("events", "event"),
    ("tasks", "task"),
    ("notes", "note"),
    ("documents", "document"),
    ("photos", "photo"),
    ("albums", "album"),
    ("locker", "locker item"),
    ("notebooks", "notebook"),
    ("folders", "folder"),
    ("lists", "list"),
    ("transactions", "transaction"),
    ("health_days", "daily figure"),
    ("workouts", "workout"),
    ("accounts", "account"),
    ("categories", "category"),
    ("budgets", "budget"),
    ("rules", "rule"),
];

fn rows<'a>(world: &'a World, section: &str) -> &'a [Value] {
    world.doc[section].as_array().map_or(&[], Vec::as_slice)
}

#[test]
fn a_default_run_is_48_train_8_val_12_test_with_distinct_seeds() {
    let specs = plan(7);
    let count = |split| specs.iter().filter(|s| s.split == split).count();
    assert_eq!(
        (count(Split::Train), count(Split::Val), count(Split::Test)),
        (48, 8, 12)
    );
    let mut seeds: Vec<u64> = specs.iter().map(|s| s.seed).collect();
    seeds.sort_unstable();
    seeds.dedup();
    assert_eq!(seeds.len(), 68);
    // growing one split moves no other world
    let bigger = plan_sized(7, |split| {
        if split == Split::Val {
            9
        } else {
            split.first_run_count()
        }
    });
    assert_eq!(specs[0], bigger[0]);
    assert_eq!(
        specs
            .iter()
            .find(|s| s.split == Split::Test)
            .map(|s| s.seed),
        bigger
            .iter()
            .find(|s| s.split == Split::Test)
            .map(|s| s.seed),
    );
}

#[test]
fn a_world_and_the_catalog_are_pure_functions_of_their_seeds() {
    for spec in plan(11).into_iter().step_by(9) {
        let (a, b) = (World::generate(spec), World::generate(spec));
        assert_eq!(a, b, "{}", spec.id());
        assert_eq!(a.seed_document(), b.seed_document());
    }
    let (a, b) = (World::generate(plan(11)[0]), World::generate(plan(12)[0]));
    assert_ne!(a.doc, b.doc, "another master seed is another world");
    assert_eq!(
        Catalog::build().expect("builds").hash(),
        Catalog::build().expect("builds").hash()
    );
}

#[test]
fn held_out_personas_use_names_the_training_worlds_never_do() {
    let owners = |split| -> Vec<String> {
        plan(3)
            .into_iter()
            .filter(|s| s.split == split)
            .map(|s| {
                World::generate(s)
                    .persona
                    .me
                    .split(' ')
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    };
    let train = owners(Split::Train);
    for held_out in [Split::Val, Split::Test] {
        for name in owners(held_out) {
            assert!(
                !train.contains(&name),
                "{name} is in train and {}",
                held_out.name()
            );
        }
    }
}

#[test]
fn every_kind_of_every_app_is_populated_in_some_world() {
    let catalog = Catalog::build().expect("builds");
    // a new member's empty vault holds nothing by design: depth is asked of every other world
    let worlds: Vec<World> = plan(1)
        .into_iter()
        .map(World::generate)
        .filter(|w| !w.settings.is_empty())
        .collect();
    for kind in &catalog.kinds {
        let (section, _) = SECTIONS
            .iter()
            .find(|(_, name)| *name == kind.name)
            .unwrap_or_else(|| panic!("no section is mapped to the kind `{}`", kind.name));
        let populated = worlds
            .iter()
            .filter(|w| !rows(w, section).is_empty())
            .count();
        assert!(
            populated > 0,
            "no world holds a {} ({})",
            kind.name,
            kind.app
        );
        // and every world, not just some, since the first run needs depth in each
        assert_eq!(
            populated,
            worlds.len(),
            "{} is empty in some worlds",
            kind.name
        );
    }
}

#[test]
fn money_and_health_have_depth() {
    for spec in plan(1).into_iter().step_by(6) {
        let world = World::generate(spec);
        assert!(rows(&world, "transactions").len() >= 40, "{}", spec.id());
        assert!(rows(&world, "budgets").len() >= 3);
        assert!(!rows(&world, "transfers").is_empty());
        assert!(rows(&world, "health_days").len() >= 100);
        assert!(rows(&world, "workouts").len() >= 4);
        let metrics: std::collections::BTreeSet<&str> = rows(&world, "health_days")
            .iter()
            .filter_map(|d| d["metric"].as_str())
            .collect();
        assert_eq!(metrics.len(), 6, "{metrics:?}");
    }
}

#[test]
fn a_locker_row_carries_presence_only() {
    const SECRETS: [&str; 6] = [
        "password",
        "card_number",
        "cvv",
        "content",
        "code",
        "otp_seed",
    ];
    for spec in plan(5) {
        let world = World::generate(spec);
        if world.settings.is_empty() {
            continue;
        }
        assert!(
            !world.doc.to_string().contains("placeholder"),
            "{}",
            spec.id()
        );
        for row in rows(&world, "locker") {
            for secret in SECRETS {
                assert!(row.get(secret).is_none(), "{} carries {secret}", spec.id());
            }
        }
        assert!(
            rows(&world, "locker")
                .iter()
                .any(|r| r["sealed"].as_array().is_some_and(|s| !s.is_empty())),
            "some item should hold a sealed secret"
        );
    }
}

#[test]
fn settings_move_the_ambiguity_they_name() {
    let spec = plan(2)[0];
    let (mut low, mut high) = ((0, 0, 0), (0, 0, 0));
    for index in 0..6 {
        let spec = centraid_datagen::WorldSpec {
            index,
            seed: spec.seed.wrapping_add(index as u64),
            ..spec
        };
        for (settings, sum) in [(Settings::LOW, &mut low), (Settings::HIGH, &mut high)] {
            let totals = measure(&World::generate_with(spec, settings)).totals;
            sum.0 += totals.near_duplicate_pairs;
            sum.1 += totals.trashed;
            sum.2 += totals.trashed_shadows;
        }
    }
    assert!(
        high.0 > low.0 * 2,
        "near duplicates: low {low:?} high {high:?}"
    );
    assert!(high.1 > low.1 * 2, "trashed: low {low:?} high {high:?}");
    assert!(high.2 >= low.2, "shadows: low {low:?} high {high:?}");
}

#[test]
fn people_sharing_a_first_name_follow_the_shared_names_setting() {
    let spec = plan(2)[1];
    let shared = |p: f64| -> usize {
        let settings = Settings {
            shared_names: p,
            near_duplicates: 0.0,
            trashed: 0.0,
            history_days: 90,
            scale: 1.0,
        };
        (0..6)
            .map(|i| {
                let s = centraid_datagen::WorldSpec {
                    seed: spec.seed + i,
                    ..spec
                };
                measure(&World::generate_with(s, settings)).people_sharing_first_name
            })
            .sum()
    };
    assert_eq!(shared(0.0), 0);
    assert!(shared(0.6) > 10);
}

fn count_of(session: &mut centraid_nativetools::Session, kind: &str) -> i64 {
    session.user("");
    let out = session.call("compute", &json!({"kind": kind, "op": "count"}));
    out["effect"]["value"]["values"][0]["amount"]
        .as_i64()
        .unwrap_or(-1)
}

#[test]
fn a_world_seeds_into_a_vault_and_reads_back_through_the_runtime() {
    let catalog = Catalog::build().expect("builds");
    // one world per archetype-ish spread: the first of each split
    for spec in [plan(1)[0], plan(1)[48], plan(1)[56]] {
        let world = World::generate(spec);
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("vault.db");
        let keys = world.seed_into(&path).expect("the world seeds");
        let seeded: BTreeMap<String, usize> =
            keys.as_object()
                .into_iter()
                .flatten()
                .fold(BTreeMap::new(), |mut by_kind, (_, v)| {
                    *by_kind
                        .entry(v["kind"].as_str().unwrap_or_default().to_owned())
                        .or_default() += 1;
                    by_kind
                });
        let now = dates::parse_now(&world.today).expect("a date");
        let mut session = vaultio::open_session(&path, now, "", Flags::default()).expect("opens");
        for kind in &catalog.kinds {
            let n = count_of(&mut session, &kind.name);
            assert!(
                n > 0,
                "{}: the runtime reads no {} (seeded {:?})",
                spec.id(),
                kind.name,
                seeded.get(&kind.name)
            );
        }
        // kinds with no read window: the runtime counts exactly the world's live rows
        for (section, kind) in [
            ("people", "person"),
            ("notes", "note"),
            ("documents", "document"),
            ("locker", "locker item"),
            ("accounts", "account"),
        ] {
            let live = rows(&world, section)
                .iter()
                .filter(|r| r.get("trashed").is_none())
                .count() as i64;
            // the owner is a person too
            let live = live + i64::from(kind == "person");
            assert_eq!(count_of(&mut session, kind), live, "{} {kind}", spec.id());
        }
        // a sealed value never reaches the prompt or a read
        let mut seen = session.prompt().to_string();
        seen.push_str(
            &session
                .call("find", &json!({"kind": "locker item"}))
                .to_string(),
        );
        assert!(
            !seen.contains("placeholder"),
            "{}: a sealed value surfaced",
            spec.id()
        );
    }
}

fn day_of(world: &World) -> jiff::civil::Date {
    world.today.parse().expect("a civil day")
}

#[test]
fn today_is_spread_over_a_year_with_every_weekday_month_ends_and_the_year_boundary() {
    let worlds: Vec<(Split, jiff::civil::Date)> = plan(7)
        .into_iter()
        .map(|spec| {
            let world = World::generate(spec);
            (spec.split, day_of(&world))
        })
        .collect();
    let days: Vec<jiff::civil::Date> = worlds.iter().map(|(_, d)| *d).collect();
    let weekdays: std::collections::BTreeSet<_> = days
        .iter()
        .map(|d| d.weekday().to_monday_zero_offset())
        .collect();
    assert_eq!(weekdays.len(), 7, "every weekday: {weekdays:?}");
    let months: std::collections::BTreeSet<_> =
        days.iter().map(|d| (d.year(), d.month())).collect();
    assert!(months.len() >= 11, "a year of months: {months:?}");
    let span = *days.iter().max().unwrap() - *days.iter().min().unwrap();
    assert!(span.get_days() >= 300, "{span}");
    assert!(days.iter().any(|d| *d == d.last_of_month()), "a month end");
    let boundary = |d: &jiff::civil::Date| {
        matches!(
            (d.year(), d.month(), d.day()),
            (2026, 12, 31) | (2027, 1, 1) | (2027, 1, 2)
        )
    };
    assert!(days.iter().any(boundary), "the turn of the year");
    // every split meets a month end or the boundary, and train meets every weekday
    for split in Split::ALL {
        let mine: Vec<_> = worlds
            .iter()
            .filter(|(s, _)| *s == split)
            .map(|(_, d)| *d)
            .collect();
        assert!(
            mine.iter().any(|d| *d == d.last_of_month() || boundary(d)),
            "{split:?} has no month end or boundary"
        );
    }
    let train: std::collections::BTreeSet<_> = worlds
        .iter()
        .filter(|(s, _)| *s == Split::Train)
        .map(|(_, d)| d.weekday().to_monday_zero_offset())
        .collect();
    assert_eq!(train.len(), 7);
}

#[test]
fn a_run_holds_a_new_members_empty_vault_and_a_very_large_one_in_every_split() {
    for spec in plan(3).into_iter().filter(|s| s.index % 8 >= 6) {
        let world = World::generate(spec);
        let total: usize = world.section_counts().iter().map(|(_, n)| n).sum();
        if spec.index % 8 == 7 {
            assert_eq!(total, 0, "{} is a new member", spec.id());
            assert!(world.doc["me"].as_str().is_some() && world.doc["today"].as_str().is_some());
        } else {
            for section in ["people", "tasks", "events", "notes"] {
                assert!(
                    rows(&world, section).len() > 150,
                    "{} {section}: {}",
                    spec.id(),
                    rows(&world, section).len()
                );
            }
            // past the assistant's window of the newest 500 rows in some kind
            assert!(
                world.section_counts().iter().any(|(_, n)| *n > 500),
                "{}",
                spec.id()
            );
        }
    }
    for split in [Split::Val, Split::Test] {
        let indices: Vec<usize> = plan(3)
            .into_iter()
            .filter(|s| s.split == split)
            .map(|s| s.index % 8)
            .collect();
        assert!(indices.contains(&6) && indices.contains(&7), "{split:?}");
    }
}

#[test]
fn names_and_money_include_indian_names_and_rupees() {
    use centraid_datagen::pools;
    for name in ["Aditi", "Sunita", "Karthik"] {
        assert!(pools::FIRST.contains(&name), "{name}");
    }
    for name in ["Sharma", "Reddy", "Gupta"] {
        assert!(pools::LAST.contains(&name), "{name}");
    }
    let worlds: Vec<World> = plan(1).into_iter().take(32).map(World::generate).collect();
    let rupee: Vec<&World> = worlds
        .iter()
        .filter(|w| w.persona.currency == "INR")
        .collect();
    assert!(!rupee.is_empty(), "some persona is paid in rupees");
    for world in rupee {
        let rows = rows(world, "transactions");
        if let Some(pay) = rows.iter().find(|r| {
            r["description"]
                .as_str()
                .is_some_and(|d| d.contains("PAYROLL"))
        }) {
            // pay is priced in dollars in the pools: rupees are about eighty times that
            assert!(pay["amount"].as_f64().unwrap_or(0.0) > 50_000.0, "{pay}");
        }
    }
}

/// Every world of the first run seeds. About two minutes in debug: `cargo test -p
/// centraid-datagen -- --ignored`.
#[test]
#[ignore = "seeds all 60 worlds; run on demand"]
fn all_sixty_worlds_seed_into_vaults() {
    for spec in plan(1) {
        let dir = tempfile::tempdir().expect("a temp dir");
        World::generate(spec)
            .seed_into(&dir.path().join("vault.db"))
            .unwrap_or_else(|error| panic!("{}: {error:#}", spec.id()));
    }
}
