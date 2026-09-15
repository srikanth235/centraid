//! Every seed that ever failed, replayed.
//!
//! This is the issue's **"a recorded failing seed from wave 2 stays green"**
//! (#1020, D-1020-D2-4). `contracts/sim/failing-seeds.json` is the register;
//! this file is what makes it more than a changelog.
//!
//! A seed is never removed from the register. A bug that came back would come
//! back on the seed that found it, and deleting the entry is the one way to
//! lose that.

use centraid_sim::{Schedule, check_invariants, run_schedule};

struct Scratch(std::path::PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn register() -> serde_json::Value {
    let path = centraid_ontology::golden::repo_root().join("contracts/sim/failing-seeds.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is committed: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is JSON: {error}", path.display()))
}

#[test]
fn the_register_is_well_formed_and_says_what_each_seed_found() {
    let register = register();
    assert_eq!(register["schema"], "centraid-sim-failing-seeds/1");
    let seeds = register["seeds"].as_array().expect("there are seeds");
    assert!(
        !seeds.is_empty(),
        "the register is empty. The simulation found two real bugs in wave 2; an empty \
         register means somebody deleted them."
    );
    for entry in seeds {
        let seed = entry["seed"].as_u64().expect("a seed is a number");
        // EVERY ENTRY EARNS ITS PLACE. A seed with no bug, no fix and no
        // regression test is a seed nobody can act on, and the register would
        // decay into a list of numbers.
        // A crate path is short; the prose fields are not, and a one-word
        // "bug" is the kind of entry that turns a register into a list of
        // numbers.
        for (field, least) in [
            ("crate", 8_usize),
            ("bug", 60),
            ("howItPresented", 40),
            ("fixShape", 40),
            ("regressionTest", 20),
        ] {
            let value = entry[field].as_str().unwrap_or_default();
            assert!(
                value.len() >= least,
                "seed {seed}'s `{field}` is {} character(s) and wants at least {least}; \
                 an entry nobody can act on is noise",
                value.len()
            );
        }
        assert!(
            entry["fixedIn"]
                .as_array()
                .is_some_and(|commits| !commits.is_empty()),
            "seed {seed} names no commit that fixed it"
        );
        assert!(
            entry["schedule"]["seed"].as_u64() == Some(seed),
            "seed {seed}'s recorded schedule names a different seed"
        );
    }
}

/// Every recorded seed still converges and still holds every invariant.
///
/// The regression test for the whole plane. A change that reintroduced either
/// bug fails here rather than in six months on a member's phone.
#[test]
fn every_recorded_seed_stays_green() {
    let register = register();
    let seeds: Vec<u64> = register["seeds"]
        .as_array()
        .expect("there are seeds")
        .iter()
        .filter_map(|entry| entry["seed"].as_u64())
        .collect();

    let mut failed: Vec<String> = Vec::new();
    for seed in &seeds {
        let schedule = Schedule::from_seed(*seed);
        let dir = centraid_ontology::golden::scratch_dir();
        let scratch = Scratch(dir.clone());
        let outcome = run_schedule(&schedule, &dir);
        if let Some(error) = &outcome.turmoil {
            failed.push(format!("seed {seed}: the world itself: {error}"));
        }
        {
            let (gateway, seats) = outcome.open();
            for finding in check_invariants(&gateway, &seats) {
                failed.push(format!("seed {seed}: {finding}"));
            }
        }
        drop(scratch);
    }
    assert!(
        failed.is_empty(),
        "a recorded seed regressed — the bug it was recorded for is back:\n  {}\n\n\
         Each seed's entry in contracts/sim/failing-seeds.json says what it found \
         and what fixed it.",
        failed.join("\n  ")
    );
    println!("{} recorded seed(s) replayed clean", seeds.len());
}

/// The determinism the register depends on.
///
/// Seed 3 was recorded because the run was NOT reproducible, so replaying it
/// means running it twice and comparing. Without this the register's other
/// entries would be replaying something that could differ each time.
#[test]
fn the_determinism_seed_replays_byte_for_byte() {
    let register = register();
    let Some(seed) = register["seeds"]
        .as_array()
        .expect("there are seeds")
        .iter()
        .find(|entry| entry["replay"].as_str() == Some("determinism"))
        .and_then(|entry| entry["seed"].as_u64())
    else {
        panic!("the register records no determinism seed; seed 3 was recorded as one");
    };

    let schedule = Schedule::from_seed(seed);
    let mut states = Vec::new();
    for _ in 0..2 {
        let dir = centraid_ontology::golden::scratch_dir();
        let scratch = Scratch(dir.clone());
        let outcome = run_schedule(&schedule, &dir);
        let (gateway, _) = outcome.open();
        states.push(centraid_sim::invariants::replicated_state(&gateway));
        drop(gateway);
        drop(scratch);
    }
    assert_eq!(
        states[0], states[1],
        "seed {seed} no longer replays byte for byte. Something reintroduced a wall-clock \
         read or an unseeded id source into the gateway's path — `CoreConfig::with_clock` \
         is what keeps a run reproducible (#1020)."
    );
}
