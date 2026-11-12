//! `datagen`: the training-data pipeline's command line. One subcommand a stage (`worlds`,
//! `intents`, `messages`, `render`), and `build --version vN` runs them in order into one data
//! version.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use centraid_datagen::ambiguity::{self, Ambiguity};
use centraid_datagen::llm::ClaudeCli;
use centraid_datagen::mix::{self, Shares};
use centraid_datagen::render::DECISION_WEIGHT;
use centraid_datagen::version::{self, Provenance, RenderConfig};
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
    /// Render a messages run (stage 6) and mix it (stage 7) into a data version: `data/{train,val,test,noise}.jsonl.zst`,
    /// `worlds/`, `build/` and a manifest. The sessions are rendered as the phone renders them, tokenized, with per-token loss weights.
    Render {
        /// The output directory of `datagen messages`.
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
        /// The `tokenizer.json` of the chat model (Qwen3.5-0.8B); its BLAKE3 goes in the manifest.
        #[arg(long)]
        tokenizer: PathBuf,
        /// The name of this data version, recorded in the manifest.
        #[arg(long, default_value = "dev")]
        version: String,
        #[command(flatten)]
        mix: MixArgs,
    },
    /// Rebuild a data version end to end: intents, messages (from the cache; `--offline` makes no call), render and mix.
    /// The stages write under `<out>/stages/`, the version under `<out>/`.
    Build {
        #[arg(long)]
        version: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        tokenizer: PathBuf,
        /// The master seed every world and intent is drawn from.
        #[arg(long, default_value_t = 1)]
        seed: u64,
        /// Worlds per split as `train,val,test` (default 48,6,6).
        #[arg(long, value_delimiter = ',')]
        counts: Option<Vec<usize>>,
        /// Sessions to draw per split as `train,val,test`. Default: half as many again as the targets, so the mix
        /// has something to choose from.
        #[arg(long, value_delimiter = ',')]
        sessions: Option<Vec<usize>>,
        #[arg(long, default_value_t = 6)]
        concurrency: usize,
        #[arg(long, default_value_t = messages::BATCH)]
        batch: usize,
        /// Fail on a messages cache miss instead of calling the model.
        #[arg(long)]
        offline: bool,
        /// At most this many sessions per split go through messages (a trial build).
        #[arg(long)]
        limit: Option<usize>,
        /// The typo stream's seed.
        #[arg(long, default_value_t = 1)]
        typo_seed: u64,
        #[arg(long, default_value = "haiku")]
        model: String,
        /// Reuse the output of a stage that already has a manifest under `<out>/stages/`.
        #[arg(long)]
        reuse: bool,
        #[command(flatten)]
        mix: MixArgs,
    },
    /// Print one session of a data version with its loss mask drawn on the decoded tokens: weight 0 as it is, weight 1
    /// in `[[ ]]`, deciding tokens in `{{ }}`.
    Show {
        /// A data version (`datagen render --out`).
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        tokenizer: PathBuf,
        #[arg(long, default_value = "train")]
        split: String,
        /// The session's id; the first of the split when left out.
        #[arg(long)]
        session: Option<String>,
        /// Characters kept at each end of a stretch of context.
        #[arg(long, default_value_t = 240)]
        keep: usize,
    },
    /// Unpack a data version's `build/llm-cache.jsonl.zst` into a messages run's `llm-cache/`, so `datagen messages
    /// --offline` (or `build --offline`) rebuilds that version with no model calls.
    UnpackCache {
        /// The packed cache (`<version>/build/llm-cache.jsonl.zst`).
        #[arg(long = "in")]
        input: PathBuf,
        /// The cache directory to fill (`<messages out>/llm-cache`, or `<build out>/stages/messages/llm-cache`).
        #[arg(long)]
        out: PathBuf,
    },
    /// Cut RFT records and DPO pairs from a model's rollouts (`assist-eval rollout`) and render them with the data
    /// version's renderer, so each carries `render {input_ids, weights, text}` as a data-version record does. Writes
    /// `rft.jsonl`, `dpo.jsonl` and `stats.json` under `--out`.
    RolloutRecords {
        /// The data version the rollouts were sampled over (`datagen render --out`): its sessions and its worlds.
        #[arg(long = "in")]
        input: PathBuf,
        /// The splits of that version the rollouts cover.
        #[arg(long, value_delimiter = ',', default_value = "train")]
        split: Vec<String>,
        /// `PREFIX.rollouts.jsonl` files (shards merge).
        #[arg(long, num_args = 1.., required = true)]
        rollouts: Vec<PathBuf>,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        tokenizer: PathBuf,
        /// A rollout report or an `assist-eval` report: what the model still fails, which weights the RFT records.
        #[arg(long)]
        needs: Option<PathBuf>,
        #[arg(long, default_value_t = 5)]
        min_samples: usize,
        #[arg(long, default_value_t = 4)]
        max_copies: usize,
        #[arg(long, default_value_t = 2)]
        pairs_per_turn: usize,
        /// The weight of a deciding token.
        #[arg(long, default_value_t = DECISION_WEIGHT)]
        decision_weight: f32,
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

/// The targets of the mix and the weight of a deciding token.
#[derive(clap::Args, Clone)]
struct MixArgs {
    /// Sessions wanted per split as `train,val,test` (~18k, ~1k, ~1k).
    #[arg(long, value_delimiter = ',', default_values_t = [18000_usize, 1000, 1000])]
    targets: Vec<usize>,
    /// Loss weight of a deciding token (an assistant token weighs 1, everything else 0).
    #[arg(long, default_value_t = DECISION_WEIGHT)]
    decision_weight: f32,
    /// Shares of sessions with one, two and three or more turns.
    #[arg(long, value_delimiter = ',', default_values_t = [0.40_f64, 0.30, 0.30])]
    turn_shares: Vec<f64>,
    /// Share of sessions that join two apps.
    #[arg(long, default_value_t = 0.30)]
    across: f64,
    /// The mix's seed.
    #[arg(long, default_value_t = 1)]
    mix_seed: u64,
    /// Sessions rendered at once.
    #[arg(long, default_value_t = 6)]
    render_concurrency: usize,
}

impl MixArgs {
    fn mix(&self) -> Result<mix::Config> {
        let [train, val, test] = self.targets[..] else {
            anyhow::bail!("--targets takes three numbers: train,val,test");
        };
        let [one, two, three] = self.turn_shares[..] else {
            anyhow::bail!("--turn-shares takes three numbers");
        };
        Ok(mix::Config {
            targets: [train, val, test],
            shares: Shares {
                one,
                two,
                three_plus: three,
                across: self.across,
            },
            seed: self.mix_seed,
            live: Vec::new(),
        })
    }

    fn render(&self, tokenizer: PathBuf) -> RenderConfig {
        RenderConfig {
            tokenizer,
            decision_weight: self.decision_weight,
            concurrency: self.render_concurrency,
        }
    }
}

fn spec_counts(counts: Option<&[usize]>) -> Result<[usize; 3]> {
    match counts {
        None => Ok([48, 6, 6]),
        Some([a, b, c]) => Ok([*a, *b, *c]),
        Some(_) => anyhow::bail!("--counts takes three numbers: train,val,test"),
    }
}

/// The seeds a messages manifest records, with the mix's own.
fn seeds_of(messages: &std::path::Path, mix_seed: u64) -> Value {
    let manifest: Value = std::fs::read_to_string(messages.join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    json!({
        "master": manifest["seeds"]["master"],
        "typos": manifest["seeds"]["typos"],
        "mix": mix_seed,
    })
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
        Command::Render {
            input,
            out,
            tokenizer,
            version: name,
            mix: mix_args,
        } => {
            let provenance = Provenance {
                version: name,
                runtime_commit: version::runtime_commit(),
                tokenizer_path: tokenizer
                    .file_name()
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
                seeds: seeds_of(&input, mix_args.mix_seed),
            };
            let text = version::render_and_mix(
                &input,
                &out,
                &mix_args.render(tokenizer),
                &mix_args.mix()?,
                &provenance,
            )?;
            print!("{text}");
        }
        Command::Build {
            version: name,
            out,
            tokenizer,
            seed,
            counts,
            sessions,
            concurrency,
            batch,
            offline,
            limit,
            typo_seed,
            model,
            reuse,
            mix: mix_args,
        } => {
            let catalog = Catalog::build()?;
            let counts = spec_counts(counts.as_deref())?;
            let mix_config = mix_args.mix()?;
            let stages = out.join("stages");
            let (intents_dir, messages_dir) = (stages.join("intents"), stages.join("messages"));
            let ready = |dir: &std::path::Path| reuse && dir.join("manifest.json").exists();
            if ready(&intents_dir) {
                eprintln!("intents: reusing {}", intents_dir.display());
            } else {
                let drawn: [usize; 3] = match sessions.as_deref() {
                    Some([a, b, c]) => [*a, *b, *c],
                    Some(_) => anyhow::bail!("--sessions takes three numbers: train,val,test"),
                    None => mix_config.targets.map(|n| n + n / 2),
                };
                let per = |total: usize, worlds: usize| total.div_ceil(worlds.max(1));
                let scratch = tempfile::tempdir()?;
                let config = run::Config {
                    seed,
                    counts,
                    per_world: [
                        per(drawn[0], counts[0]),
                        per(drawn[1], counts[1]),
                        per(drawn[2], counts[2]),
                    ],
                    cell_limit: None,
                };
                let generated = run::generate(&config, &catalog, scratch.path())?;
                run::write(&intents_dir, &config, &catalog, &generated)?;
                eprintln!("intents: {} sessions", generated.kept.len());
            }
            if ready(&messages_dir) {
                eprintln!("messages: reusing {}", messages_dir.display());
            } else {
                let mut llm = ClaudeCli::haiku();
                llm.model = model;
                let config = messages::Config {
                    batch,
                    concurrency,
                    offline,
                    limit,
                    seed: typo_seed,
                };
                let report = messages::run(&config, &catalog, &llm, &intents_dir, &messages_dir)?;
                eprintln!("model calls: {}, cache hits: {}", report.calls, report.hits);
            }
            let provenance = Provenance {
                version: name,
                runtime_commit: version::runtime_commit(),
                tokenizer_path: tokenizer
                    .file_name()
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
                seeds: seeds_of(&messages_dir, mix_args.mix_seed),
            };
            let text = version::render_and_mix(
                &messages_dir,
                &out,
                &mix_args.render(tokenizer),
                &mix_config,
                &provenance,
            )?;
            print!("{text}");
        }
        Command::UnpackCache { input, out } => {
            let n = version::unpack_cache(&input, &out)?;
            eprintln!("unpacked {n} cache entries into {}", out.display());
        }
        Command::Show {
            input,
            tokenizer,
            split,
            session,
            keep,
        } => {
            let tokenizer = centraid_datagen::render::Tokenizer::open(&tokenizer)?;
            let path = version::split_path(&input, &split);
            let bytes = zstd::stream::decode_all(
                std::fs::File::open(&path).with_context(|| path.display().to_string())?,
            )?;
            let text = String::from_utf8(bytes)?;
            let record: Value = text
                .lines()
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .find(|r| session.as_deref().is_none_or(|id| r["id"] == id))
                .context("no such session")?;
            let ids: Vec<u32> = serde_json::from_value(record["render"]["input_ids"].clone())?;
            let weights: Vec<f32> = serde_json::from_value(record["render"]["weights"].clone())?;
            println!("session {} ({} tokens)", record["id"], ids.len());
            for turn in record["turns"].as_array().into_iter().flatten() {
                println!("  user: {}", turn["user"]);
            }
            println!(
                "{}",
                centraid_datagen::render::visualise(&tokenizer, &ids, &weights, keep)?
            );
        }
        Command::RolloutRecords {
            input,
            split,
            rollouts,
            out,
            tokenizer,
            needs,
            min_samples,
            max_copies,
            pairs_per_turn,
            decision_weight,
        } => {
            use centraid_assist_eval::rollout::records::{self, Cutting, Needs, Weighing};
            use centraid_assist_eval::source::EvalSource;
            use centraid_assist_eval::tally::{WithoutInProgress, WithoutTally};
            let names: Vec<&str> = split.iter().map(String::as_str).collect();
            let source = WithoutInProgress::new(WithoutTally::new(
                centraid_datagen::source::DatagenSource::open_version(&input, &names)?,
            ));
            let sessions = source.sessions()?;
            // before the tokenizer and the renderer are loaded: val, test and noise are never training data
            records::refuse_held_out(&sessions)?;
            let rollouts = centraid_assist_eval::rollout::read_rollouts(&rollouts)?;
            let needs = match &needs {
                Some(path) => Needs::read(path, min_samples)?,
                None => Needs::default(),
            };
            let tokenizer = centraid_datagen::render::Tokenizer::open(&tokenizer)?;
            let catalog = Catalog::build()?;
            let worlds = centraid_datagen::rollout::read_worlds(
                &input,
                sessions.iter().map(|s| s.world.as_str()),
            )?;
            let scratch = tempfile::tempdir()?;
            let renderer = centraid_datagen::rollout::Renderer::new(
                &catalog,
                &worlds,
                &tokenizer,
                decision_weight,
                scratch.path(),
            );
            let stats = records::cut(
                &sessions,
                &rollouts,
                &Cutting {
                    needs: &needs,
                    weighing: Weighing {
                        max_copies,
                        ..Weighing::default()
                    },
                    pairs_per_turn,
                },
                Some(&renderer),
                &out,
            )?;
            println!("{}", serde_json::to_string_pretty(&stats)?);
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
