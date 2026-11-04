//! `datagen`: the training-data pipeline's command line. Stage subcommands are added beside
//! `worlds`, `intents` and `messages`; `build --version vN` will run them in order once render
//! and mix exist.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use centraid_datagen::ambiguity::{self, Ambiguity};
use centraid_datagen::llm::ClaudeCli;
use centraid_datagen::world::{World, WorldSpec, plan, plan_sized};
use centraid_datagen::{Catalog, Split, messages, run};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(
    name = "datagen",
    about = "The chat model's training-data pipeline (#1166)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the catalog and its hash, or write it to `--out`.
    Catalog {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Generate the worlds of a run and write them with a manifest.
    Worlds {
        /// The master seed every world's seed is drawn from.
        #[arg(long)]
        seed: u64,
        #[arg(long)]
        out: PathBuf,
        /// Worlds per split as `train,val,test` (default 48,6,6).
        #[arg(long, value_delimiter = ',')]
        counts: Option<Vec<usize>>,
        /// Also seed every world into a vault file `<out>/<split>/<id>.vault`.
        #[arg(long)]
        vaults: bool,
    },
    /// Draw intents and solve them against the runtime (stages 2 and 3): sessions in the shape
    /// `assist-eval` reads, plus a coverage report.
    Intents {
        #[arg(long)]
        seed: u64,
        #[arg(long)]
        out: PathBuf,
        /// Worlds per split as `train,val,test` (default 48,6,6).
        #[arg(long, value_delimiter = ',')]
        counts: Option<Vec<usize>>,
        /// Sessions to keep per world, one number or `train,val,test`; never fewer than one per
        /// live grid cell.
        #[arg(long, value_delimiter = ',')]
        per_world: Option<Vec<usize>>,
        /// Sessions to keep per split as `train,val,test` (the first run: 18000,1000,1000);
        /// sets `--per-world` from the world counts.
        #[arg(long, value_delimiter = ',')]
        sessions: Option<Vec<usize>>,
    },
    /// Write phone-style messages for an intents run and verify them (stages 4 and 5): Claude
    /// Haiku through headless Claude Code writes and reads back, every output cached by prompt
    /// hash under `<out>/llm-cache`.
    Messages {
        /// The output directory of `datagen intents`.
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
        /// Calls in flight, and worlds replayed at once.
        #[arg(long, default_value_t = 6)]
        concurrency: usize,
        /// Sessions per Haiku call.
        #[arg(long, default_value_t = messages::BATCH)]
        batch: usize,
        /// Fail on a cache miss instead of calling the model: a rebuild from the cache.
        #[arg(long)]
        offline: bool,
        /// At most this many sessions per split, spread evenly over its file.
        #[arg(long)]
        limit: Option<usize>,
        /// The typo stream's seed.
        #[arg(long, default_value_t = 1)]
        seed: u64,
        /// The model passed to `claude --model`.
        #[arg(long, default_value = "haiku")]
        model: String,
    },
    /// Print how ambiguous each world is under its settings.
    Ambiguity {
        #[arg(long)]
        seed: u64,
        #[arg(long, value_delimiter = ',')]
        counts: Option<Vec<usize>>,
        /// Print the per-world records as JSON instead of the table.
        #[arg(long)]
        json: bool,
    },
}

fn specs(seed: u64, counts: Option<&[usize]>) -> Result<Vec<WorldSpec>> {
    match counts {
        None => Ok(plan(seed)),
        Some([train, val, test]) => Ok(plan_sized(seed, |split| match split {
            Split::Train => *train,
            Split::Val => *val,
            Split::Test => *test,
        })),
        Some(_) => anyhow::bail!("--counts takes three numbers: train,val,test"),
    }
}

fn ambiguity_record(world: &World, ambiguity: &Ambiguity) -> Value {
    json!({
        "world": world.id(),
        "settings": world.settings,
        "ambiguity": ambiguity,
    })
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Catalog { out } => {
            let catalog = Catalog::build()?;
            let text = serde_json::to_string_pretty(&catalog)?;
            match out {
                Some(path) => {
                    std::fs::write(&path, text).with_context(|| path.display().to_string())?
                }
                None => println!("{text}"),
            }
            let (kinds, verbs, fields) = catalog.counts();
            eprintln!(
                "catalog {} — {kinds} kinds, {verbs} verbs, {fields} fields",
                catalog.hash()
            );
        }
        Command::Worlds {
            seed,
            out,
            counts,
            vaults,
        } => {
            let catalog = Catalog::build()?;
            let mut manifest = Vec::new();
            for spec in specs(seed, counts.as_deref())? {
                let world = World::generate(spec);
                let dir = out.join(spec.split.name());
                std::fs::create_dir_all(&dir)?;
                let path = dir.join(format!("{}.json", world.id()));
                std::fs::write(&path, serde_json::to_string_pretty(&world.doc)?)?;
                if vaults {
                    let vault = dir.join(format!("{}.vault", world.id()));
                    world.seed_into(&vault)?;
                }
                let measured = ambiguity::measure(&world);
                manifest.push(json!({
                    "id": world.id(), "split": spec.split, "seed": spec.seed,
                    "persona": world.persona, "settings": world.settings, "today": world.today,
                    "sections": world.section_counts().into_iter().collect::<BTreeMap<_, _>>(),
                    "ambiguity": measured.totals,
                }));
                eprintln!("{}", world.id());
            }
            let manifest =
                json!({"catalog_hash": catalog.hash(), "master_seed": seed, "worlds": manifest});
            std::fs::write(
                out.join("manifest.json"),
                serde_json::to_string_pretty(&manifest)?,
            )?;
        }
        Command::Intents {
            seed,
            out,
            counts,
            per_world,
            sessions,
        } => {
            let catalog = Catalog::build()?;
            let counts: [usize; 3] = match counts.as_deref() {
                None => [48, 6, 6],
                Some([a, b, c]) => [*a, *b, *c],
                Some(_) => anyhow::bail!("--counts takes three numbers: train,val,test"),
            };
            let per_world: [usize; 3] = match (sessions.as_deref(), per_world.as_deref()) {
                (Some([a, b, c]), _) => {
                    let per = |total: usize, worlds: usize| total.div_ceil(worlds.max(1));
                    [per(*a, counts[0]), per(*b, counts[1]), per(*c, counts[2])]
                }
                (Some(_), _) => anyhow::bail!("--sessions takes three numbers: train,val,test"),
                (None, Some([n])) => [*n; 3],
                (None, Some([a, b, c])) => [*a, *b, *c],
                (None, Some(_)) => anyhow::bail!("--per-world takes one number or three"),
                (None, None) => [0; 3],
            };
            let scratch = tempfile::tempdir()?;
            let config = run::Config {
                seed,
                counts,
                per_world,
                cell_limit: None,
            };
            let generated = run::generate(&config, &catalog, scratch.path())?;
            let report = run::write(&out, &config, &catalog, &generated)?;
            print!("{report}");
        }
        Command::Messages {
            input,
            out,
            concurrency,
            batch,
            offline,
            limit,
            seed,
            model,
        } => {
            let catalog = Catalog::build()?;
            let mut llm = ClaudeCli::haiku();
            llm.model = model;
            let config = messages::Config {
                batch,
                concurrency,
                offline,
                limit,
                seed,
            };
            let report = messages::run(&config, &catalog, &llm, &input, &out)?;
            print!("{}", report.text);
            eprintln!("model calls: {}, cache hits: {}", report.calls, report.hits);
        }
        Command::Ambiguity { seed, counts, json } => {
            let rows: Vec<(World, Ambiguity)> = specs(seed, counts.as_deref())?
                .into_iter()
                .map(|spec| {
                    let world = World::generate(spec);
                    let measured = ambiguity::measure(&world);
                    (world, measured)
                })
                .collect();
            if json {
                let all: Vec<Value> = rows.iter().map(|(w, a)| ambiguity_record(w, a)).collect();
                println!("{}", serde_json::to_string_pretty(&all)?);
            } else {
                print!("{}", table(&rows));
            }
        }
    }
    Ok(())
}

/// One line per world: its settings, then people sharing a first name, exact-name groups and
/// near-duplicate pairs (transactions apart: a merchant repeats by nature), trashed rows and how
/// many shadow a live name.
fn table(rows: &[(World, Ambiguity)]) -> String {
    let mut out = String::from(
        "world       shared near  trash hist | people-first  groups  near-pairs  trashed  shadows  confusable%\n",
    );
    for (world, ambiguity) in rows {
        let (mut groups, mut pairs, mut trashed, mut shadows, mut confusable, mut live) =
            (0, 0, 0, 0, 0, 0);
        for (kind, k) in &ambiguity.kinds {
            trashed += k.trashed;
            shadows += k.trashed_shadows;
            if kind != "transaction" {
                groups += k.exact_name_groups;
                pairs += k.near_duplicate_pairs;
                confusable += k.confusable_rows;
                live += k.rows - k.trashed;
            }
        }
        let s = world.settings;
        out.push_str(&format!(
            "{:<11} {:>5.2} {:>5.2} {:>5.2} {:>4} | {:>12}  {:>6}  {:>10}  {:>7}  {:>7}  {:>10.1}\n",
            world.id(), s.shared_names, s.near_duplicates, s.trashed, s.history_days,
            ambiguity.people_sharing_first_name, groups, pairs, trashed, shadows,
            100.0 * f64::from(u32::try_from(confusable).unwrap_or(0)) / f64::from(u32::try_from(live.max(1)).unwrap_or(1)),
        ));
    }
    out
}
