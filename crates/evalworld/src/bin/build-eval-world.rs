//! REBUILD THE WORLD FROM SCRATCH.
//!
//! ```text
//! cargo run -p centraid-evalworld --bin build-eval-world -- <dir>
//! cargo run -p centraid-evalworld --bin build-eval-world -- <dir> --scenario 2
//! ```
//!
//! **`--scenario 2` is a SECOND WORLD, not a second build of the first.** Its
//! cast, places, trip and collisions are disjoint from world 1's, and
//! `holdout.json` is written against it — see
//! [`centraid_evalworld::Scenario`]. Build it somewhere of its own
//! (`target/eval-world-2`): the two are different vaults and neither may be
//! seeded over the other.
//!
//! Writes `<dir>/world.db`, its byte store `<dir>/world.bytes`, its Locker key
//! custody `<dir>/keys`, and `<dir>/inventory.json` — the artifact a later lane
//! authors its corpus against.
//!
//! **It refuses a directory that already holds a founded vault, and there is no
//! `--force`.** `crates/centraid/src/bin/seed-demo-vault.rs` learned that the
//! hard way: pointed at a gateway's own directory, a seeder that deletes what it
//! seeds destroys a vault somebody is serving and founds a new one under a new
//! id in a directory still named after the old one. An evaluation world is
//! always written somewhere new, so the escape hatch has no case to serve.
//!
//! **A refusal is a non-zero exit.** A world quietly missing an app is the one
//! failure every later lane would score against without knowing.

use std::path::PathBuf;

fn main() {
    // `--scenario N` ANYWHERE, so the directory keeps its place as the one
    // positional argument it has always been.
    let mut scenario = centraid_evalworld::Scenario::First;
    let mut positional: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--scenario" | "--world" => {
                let Some(which) = args.next() else {
                    eprintln!("build-eval-world: --scenario takes 1 or 2");
                    std::process::exit(2);
                };
                match centraid_evalworld::Scenario::parse(&which) {
                    Ok(parsed) => scenario = parsed,
                    Err(why) => {
                        eprintln!("build-eval-world: {why}");
                        std::process::exit(2);
                    }
                }
            }
            _ => positional.push(argument),
        }
    }
    let dir = positional
        .first()
        .map_or_else(|| PathBuf::from("target/eval-world"), PathBuf::from);
    if let Some(unexpected) = positional.get(1) {
        eprintln!("build-eval-world: unexpected argument {unexpected:?}; it takes one directory");
        std::process::exit(2);
    }

    match centraid_evalworld::build_scenario(&dir, scenario) {
        Ok(world) => {
            println!("CENTRAID_EVAL_WORLD={}", world.vault_path.display());
            println!(
                "CENTRAID_EVAL_INVENTORY={}",
                dir.join("inventory.json").display()
            );
            println!("CENTRAID_EVAL_NOW={}", world.inventory.now);
            println!("CENTRAID_EVAL_SEED={}", world.inventory.seed);
            let counts: Vec<String> = world
                .inventory
                .counts()
                .into_iter()
                .map(|(app, count)| format!("{app}={count}"))
                .collect();
            println!("CENTRAID_EVAL_ROWS {}", counts.join(" "));
            // THE PLANTED AMBIGUITIES, COUNTED. A world that has stopped being
            // ambiguous still builds, and this line is the only place that says
            // so before a whole suite is scored against it.
            // THE PLANTED AMBIGUITIES OF WHICHEVER WORLD THIS IS. The two
            // share no proper noun, so one list could not serve both.
            let needles: &[&str] = match scenario {
                centraid_evalworld::Scenario::First => {
                    &["dentist", "Neha", "Marco", "Emerald Bay"]
                }
                centraid_evalworld::Scenario::Second => {
                    &["optometrist", "Yusuf", "Halla", "Glass Beach"]
                }
            };
            for needle in needles {
                println!(
                    "CENTRAID_EVAL_COLLISION {needle}={}",
                    world.inventory.matching(needle).len()
                );
            }
        }
        Err(why) => {
            eprintln!("build-eval-world: {why}");
            std::process::exit(1);
        }
    }
}
