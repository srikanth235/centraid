//! `datagen`: the training-data pipeline's command line. One subcommand a stage (`worlds`,
//! `intents`, `messages`, `render`), and `build --version vN` runs them in order into one data
//! version.

use centraid_datagen::mistakes as datagen_mistakes;
use centraid_datagen::rehearsal as datagen_rehearsal;
use centraid_datagen::style as datagen_style;
use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use centraid_datagen::ambiguity::{self, Ambiguity};
use centraid_datagen::llm::{ClaudeCli, Llm};
use centraid_datagen::mix::{self, Shares};
use centraid_datagen::render::DECISION_WEIGHT;
use centraid_datagen::version::{self, Provenance, RenderConfig};
use centraid_datagen::world::{World, WorldSpec, plan, plan_sized};
use centraid_datagen::{Catalog, Split, messages, publish, run};
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
        /// Worlds per split as `train,val,test` (default 48,8,12).
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
        /// Worlds per split as `train,val,test` (default 48,8,12).
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
        /// Refused calls from a model's rollouts (`*.rollouts.jsonl`): a repair turn that reads shows one of
        /// these, refused by the runtime again, in place of a constructed mistake.
        #[arg(long)]
        mistakes: Option<PathBuf>,
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
        /// Instead of calling a model, write each prompt the cache lacks under `<dir>/{writer,reader}/<split>/`
        /// and stop; answer them elsewhere and put them back with `cache-put`.
        #[arg(long)]
        collect: Option<PathBuf>,
        /// At most this many sessions per split, spread evenly over its file.
        #[arg(long)]
        limit: Option<usize>,
        /// The typo stream's seed.
        #[arg(long, default_value_t = 1)]
        seed: u64,
        #[command(flatten)]
        models: ModelArgs,
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
        /// Refused calls from a model's rollouts (`*.rollouts.jsonl`) for the repair turns that read.
        #[arg(long)]
        mistakes: Option<PathBuf>,
        /// Worlds per split as `train,val,test` (default 48,8,12).
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
        /// Instead of calling a model, write each prompt the cache lacks under `<dir>/{writer,reader}/<split>/`
        /// and stop; answer them elsewhere and put them back with `cache-put`.
        #[arg(long)]
        collect: Option<PathBuf>,
        /// At most this many sessions per split go through messages (a trial build).
        #[arg(long)]
        limit: Option<usize>,
        /// The typo stream's seed.
        #[arg(long, default_value_t = 1)]
        typo_seed: u64,
        #[command(flatten)]
        models: ModelArgs,
        /// Reuse the output of a stage that already has a manifest under `<out>/stages/`.
        #[arg(long)]
        reuse: bool,
        #[command(flatten)]
        mix: MixArgs,
    },
    /// Publish a built data version to a Hugging Face dataset repo, one revision per version. A DRY RUN unless `--upload`:
    /// it checks the version (file hashes, a clean build, publishable, no sealed placeholder), lists every file with
    /// its size and hash and uploads nothing (with `--repo` and `HF_TOKEN` it also reads the repo's tree and lists the
    /// paths the commit would remove: a version's tree is exactly its files). A real upload needs `--upload`, `--repo` and `HF_TOKEN` in the
    /// environment; the repo is private unless `--public`, the revision is the version's name, and an existing
    /// revision is never overwritten.
    Publish {
        /// A data version (`datagen build --out`).
        #[arg(long = "in")]
        input: PathBuf,
        /// The dataset repo, as owner/name. For this project: srikanth235/centraid-native-data.
        #[arg(long)]
        repo: Option<String>,
        /// Really upload (needs `--repo` and `HF_TOKEN`).
        #[arg(long)]
        upload: bool,
        /// Make the repo public when it is created. Private by default.
        #[arg(long)]
        public: bool,
        /// The Python that runs `huggingface_hub` for the upload.
        #[arg(long, default_value = "python3")]
        python: String,
    },
    /// Write the byte-level TEST tokenizer to a file, for a rehearsal build that needs no model and no download. A
    /// version rendered with it is marked not publishable.
    TestTokenizer {
        #[arg(long)]
        out: PathBuf,
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
    /// Put answers into an LLM cache, one JSON line each (`{"model", "hash", "response"}`), where `hash` is the file
    /// name of a prompt `--collect` wrote. An entry already in the cache is kept.
    CachePut {
        /// The cache directory (`<messages out>/llm-cache`, or `<build out>/stages/messages/llm-cache`).
        #[arg(long)]
        cache: PathBuf,
        /// The answers, a `.jsonl` file.
        #[arg(long)]
        answers: PathBuf,
    },
    /// Cut RFT records from a model's rollouts (`assist-eval rollout`) and render them with the data
    /// version's renderer, so each carries `render {input_ids, weights, text}` as a data-version record does. Writes
    /// `rft.jsonl` and `stats.json` under `--out`.
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
    /// Sessions wanted per split as `train,val,test`.
    #[arg(long, value_delimiter = ',', default_values_t = [5000_usize, 500, 1000])]
    targets: Vec<usize>,
    /// Loss weight of a deciding token (an assistant token weighs 1, everything else 0).
    #[arg(long, default_value_t = DECISION_WEIGHT)]
    decision_weight: f32,
    /// Shares of sessions with one, two and three or more turns.
    #[arg(long, value_delimiter = ',', default_values_t = [0.40_f64, 0.30, 0.30])]
    turn_shares: Vec<f64>,
    /// Share of sessions that touch two kinds.
    #[arg(long, default_value_t = 0.20)]
    two_kinds: f64,
    /// Shares of turns by outcome: done, nothing found, ask, decline, repair.
    #[arg(long, value_delimiter = ',', default_values_t = [0.65_f64, 0.08, 0.10, 0.07, 0.10])]
    outcome_shares: Vec<f64>,
    /// Shares of turns by action: read/count/measure, create/edit/other write, recall/undo.
    #[arg(long, value_delimiter = ',', default_values_t = [0.45_f64, 0.45, 0.10])]
    action_shares: Vec<f64>,
    /// Shares of row-pointing turns by reference: name, filters, pronoun or earlier answer, nickname or misspelling.
    #[arg(long, value_delimiter = ',', default_values_t = [0.40_f64, 0.25, 0.20, 0.15])]
    reference_shares: Vec<f64>,
    /// Share of turns that ask for what the vault cannot do.
    #[arg(long, default_value_t = 0.05)]
    impossible: f64,
    /// Share of test sessions that carry a reserved combination.
    #[arg(long, default_value_t = 0.20)]
    reserved_share: f64,
    /// Turns every live cell has at least, per split as `train,val,test`.
    #[arg(long, value_delimiter = ',', default_values_t = [30_usize, 0, 0])]
    cell_floor: Vec<usize>,
    /// Nested train subsets, in sessions (for a learning curve).
    #[arg(long, value_delimiter = ',', default_values_t = [1000_usize, 2500])]
    subsets: Vec<usize>,
    /// Combinations reserved for test (a kind with a filter field, a kind with a verb and a constraint count).
    #[arg(long, default_value_t = 8)]
    reserve: usize,
    /// The mix's seed.
    #[arg(long, default_value_t = 1)]
    mix_seed: u64,
    /// Sessions rendered at once.
    #[arg(long, default_value_t = 6)]
    render_concurrency: usize,
}

fn exactly<const N: usize>(name: &str, values: &[f64]) -> Result<[f64; N]> {
    <[f64; N]>::try_from(values)
        .map_err(|_| anyhow::anyhow!("--{name} takes {N} numbers, got {}", values.len()))
}

impl MixArgs {
    fn mix(&self) -> Result<mix::Config> {
        let [train, val, test] = self.targets[..] else {
            anyhow::bail!("--targets takes three numbers: train,val,test");
        };
        let [one, two, three] = exactly::<3>("turn-shares", &self.turn_shares)?;
        let [f_train, f_val, f_test] = self.cell_floor[..] else {
            anyhow::bail!("--cell-floor takes three numbers: train,val,test");
        };
        Ok(mix::Config {
            targets: [train, val, test],
            shares: Shares {
                one,
                two,
                three_plus: three,
                two_kinds: self.two_kinds,
                outcome: exactly::<5>("outcome-shares", &self.outcome_shares)?,
                action: exactly::<3>("action-shares", &self.action_shares)?,
                reference: exactly::<4>("reference-shares", &self.reference_shares)?,
                impossible: self.impossible,
                reserved: self.reserved_share,
            },
            seed: self.mix_seed,
            live: Vec::new(),
            floor: [f_train, f_val, f_test],
            subsets: self.subsets.clone(),
            reserved: Vec::new(),
            reserve: self.reserve,
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
        None => Ok([48, 8, 12]),
        Some([a, b, c]) => Ok([*a, *b, *c]),
        Some(_) => anyhow::bail!("--counts takes three numbers: train,val,test"),
    }
}

/// The seeds a messages manifest records, with the mix's own.
/// Which model writes and which reads back, split by split.
#[derive(clap::Args, Debug)]
struct ModelArgs {
    /// The writer: one model for every split (`haiku`) or one per split (`train=haiku,val=haiku,test=sonnet`). Names go
    /// to `claude --model`; `rehearsal` (or `rehearsal-b`) is the offline stand-in that makes no call. The test split's
    /// writer must differ from train's, and no split's reader may be its writer.
    #[arg(long, default_value = "train=haiku,val=haiku,test=sonnet")]
    writer: String,
    /// The reader that reads each message back, in the same forms as `--writer`.
    #[arg(long, default_value = "train=sonnet,val=sonnet,test=haiku")]
    reader: String,
    /// The share of sessions in each style: terse, dictated, typos, long_polite, correction.
    #[arg(long, value_delimiter = ',', default_values_t = datagen_style::DEFAULT_SHARES)]
    style_shares: Vec<f64>,
}

/// The language models of a run, owned once each.
struct BuiltModels {
    all: Vec<Box<dyn Llm>>,
    writer: [usize; 3],
    reader: [usize; 3],
}

impl BuiltModels {
    fn models(&self) -> messages::Models<'_> {
        let at = |i: [usize; 3]| [&*self.all[i[0]], &*self.all[i[1]], &*self.all[i[2]]];
        messages::Models {
            writer: at(self.writer),
            reader: at(self.reader),
        }
    }
}

fn per_split(spec: &str) -> Result<[String; 3]> {
    if !spec.contains('=') {
        return Ok([spec.to_owned(), spec.to_owned(), spec.to_owned()]);
    }
    let mut out: [Option<String>; 3] = [None, None, None];
    for part in spec.split(',') {
        let (split, model) = part
            .split_once('=')
            .with_context(|| format!("`{part}`: expected split=model"))?;
        let at = Split::ALL
            .iter()
            .position(|s| s.name() == split.trim())
            .with_context(|| format!("`{split}` is not a split (train, val, test)"))?;
        out[at] = Some(model.trim().to_owned());
    }
    let [a, b, c] = out;
    match (a, b, c) {
        (Some(a), Some(b), Some(c)) => Ok([a, b, c]),
        _ => anyhow::bail!("`{spec}` must name train, val and test, or one model for all"),
    }
}

impl ModelArgs {
    fn style_shares(&self) -> Result<[f64; 5]> {
        let [a, b, c, d, e] = self.style_shares[..] else {
            anyhow::bail!(
                "--style-shares takes five numbers: terse,dictated,typos,long_polite,correction"
            );
        };
        Ok([a, b, c, d, e])
    }

    fn build(&self, catalog: &Catalog, intents: &std::path::Path) -> Result<BuiltModels> {
        let mut all: Vec<Box<dyn Llm>> = Vec::new();
        let mut seen: Vec<(&str, String)> = Vec::new();
        let mut pick = |role: &'static str, names: &[String; 3]| -> Result<[usize; 3]> {
            let mut at = [0; 3];
            for (i, name) in names.iter().enumerate() {
                let known = seen.iter().position(|(r, n)| *r == role && n == name);
                at[i] = if let Some(k) = known {
                    k
                } else {
                    let llm: Box<dyn Llm> = if let Some(suffix) = name.strip_prefix("rehearsal") {
                        Box::new(datagen_rehearsal::Rehearsal::new(
                            &format!("{role}{suffix}"),
                            catalog,
                            intents,
                        )?)
                    } else {
                        let mut cli = ClaudeCli::haiku();
                        cli.model.clone_from(name);
                        Box::new(cli)
                    };
                    all.push(llm);
                    seen.push((role, name.clone()));
                    all.len() - 1
                };
            }
            Ok(at)
        };
        let writer = pick("writer", &per_split(&self.writer)?)?;
        let reader = pick("reader", &per_split(&self.reader)?)?;
        Ok(BuiltModels {
            all,
            writer,
            reader,
        })
    }
}

/// The refused calls `--mistakes` names, with a line on what was read.
fn load_mistakes(path: Option<&std::path::Path>) -> Result<Vec<datagen_mistakes::Observed>> {
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    let loaded = datagen_mistakes::observed(path)?;
    eprintln!(
        "mistakes: {} refused read calls from {} refused turns ({} calls left out: not a read, or an argument that cannot be spelled)",
        loaded.calls.len(),
        loaded.refused_turns,
        loaded.unspellable
    );
    Ok(loaded.calls)
}

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
            mistakes,
        } => {
            let catalog = Catalog::build()?;
            let mistakes = load_mistakes(mistakes.as_deref())?;
            let counts: [usize; 3] = match counts.as_deref() {
                None => [48, 8, 12],
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
                mistakes,
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
            collect,
            limit,
            seed,
            models,
        } => {
            let catalog = Catalog::build()?;
            let built = models.build(&catalog, &input)?;
            let config = messages::Config {
                batch,
                concurrency,
                offline,
                collect,
                limit,
                seed,
                style_shares: models.style_shares()?,
            };
            let report = messages::run(&config, &catalog, &built.models(), &input, &out)?;
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
            mistakes,
            counts,
            sessions,
            concurrency,
            batch,
            offline,
            collect,
            limit,
            typo_seed,
            models,
            reuse,
            mix: mix_args,
        } => {
            let catalog = Catalog::build()?;
            let counts = spec_counts(counts.as_deref())?;
            let mix_config = mix_args.mix()?;
            let mistakes = load_mistakes(mistakes.as_deref())?;
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
                    mistakes: mistakes.clone(),
                };
                let generated = run::generate(&config, &catalog, scratch.path())?;
                run::write(&intents_dir, &config, &catalog, &generated)?;
                eprintln!("intents: {} sessions", generated.kept.len());
            }
            if ready(&messages_dir) {
                eprintln!("messages: reusing {}", messages_dir.display());
            } else {
                let built = models.build(&catalog, &intents_dir)?;
                let config = messages::Config {
                    batch,
                    concurrency,
                    offline,
                    collect,
                    limit,
                    seed: typo_seed,
                    style_shares: models.style_shares()?,
                };
                let report = messages::run(
                    &config,
                    &catalog,
                    &built.models(),
                    &intents_dir,
                    &messages_dir,
                )?;
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
        Command::Publish {
            input,
            repo,
            upload,
            public,
            python,
        } => {
            let named = repo.as_deref().unwrap_or(publish::EXAMPLE_REPO);
            let publication = publish::prepare(&input, named)?;
            if upload {
                let repo = repo.context("--upload needs --repo owner/name")?;
                let token = publish::token_from_env()?;
                let done = publish::upload(&publication, &repo, !public, &python, &token)?;
                println!("{done}");
            } else {
                // a read-only listing of the repo's tree, when it can be had, so the removals are shown
                let remote = match (repo.as_deref(), publish::token_from_env()) {
                    (Some(r), Ok(token)) => Some(publish::list_remote(r, &python, &token)?),
                    _ => None,
                };
                print!(
                    "{}",
                    publish::dry_run(&publication, repo.as_deref(), !public, remote.as_deref())
                );
            }
        }
        Command::TestTokenizer { out } => {
            std::fs::write(&out, centraid_datagen::render::byte_level_tokenizer_json())?;
            eprintln!("wrote {}", out.display());
        }
        Command::CachePut { cache, answers } => {
            let (mut put, mut kept) = (0, 0);
            for line in std::fs::read_to_string(&answers)?
                .lines()
                .filter(|l| !l.trim().is_empty())
            {
                let v: Value = serde_json::from_str(line)?;
                let field = |k: &str| {
                    v[k].as_str()
                        .with_context(|| format!("an answer with no `{k}`"))
                };
                if centraid_datagen::llm::put(
                    &cache,
                    field("model")?,
                    field("hash")?,
                    field("response")?,
                )? {
                    put += 1;
                } else {
                    kept += 1;
                }
            }
            eprintln!(
                "put {put} answers into {} ({kept} already there)",
                cache.display()
            );
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
