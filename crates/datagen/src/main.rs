//! `datagen`: the evolvable training-data pipeline CLI (#1188).

use std::path::PathBuf;

use anyhow::{Context, Result};
use centraid_datagen::ambiguity::{self, Ambiguity};
use centraid_datagen::declarations::Declarations;
use centraid_datagen::deficit::{self, PlanConfig};
use centraid_datagen::fixture_world::{self, FixtureRequest};
use centraid_datagen::intents;
use centraid_datagen::mix::{self, Shares};
use centraid_datagen::phrasing_cache::{CacheScope, PhrasingCache};
use centraid_datagen::render::DECISION_WEIGHT;
use centraid_datagen::version::{self, BuildConfig, Provenance, RenderConfig};
use centraid_datagen::{Catalog, Split, publish};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(
    name = "datagen",
    about = "The chat model's evolvable training-data pipeline (#1188)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the catalog JSON and emit `catalog <hash>` and `declarations <hash>` on stderr.
    Catalog {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Print the full declarations schema (`{type, value_maker, live, wording_hint, meaning_key}`).
    Declarations {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Compute the incremental work order against isolated phrasing caches (`--dry-run` supported).
    Plan {
        #[arg(long, default_value = "v0.4")]
        version: String,
        #[arg(long)]
        cache: PathBuf,
        #[arg(long, default_value_t = 1)]
        seed: u64,
        #[arg(long)]
        prev_declarations: Option<PathBuf>,
        #[arg(long)]
        export: Option<PathBuf>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long, value_delimiter = ',', default_values_t = [5000_usize, 500, 1000])]
        targets: Vec<usize>,
        #[arg(long, default_value_t = 30)]
        train_floor: usize,
        #[arg(long, default_value_t = 9)]
        variants: usize,
        #[arg(long, default_value_t = 0.10)]
        refresh_rate: f64,
        #[arg(long, default_value_t = 16)]
        batch_size: usize,
    },
    /// Export pending writer/reader JSON batches for Phase D Hydrogen swarm subagents.
    ExportBatches {
        #[arg(long, default_value = "v0.4")]
        version: String,
        #[arg(long)]
        cache: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = 1)]
        seed: u64,
        #[arg(long)]
        prev_declarations: Option<PathBuf>,
        #[arg(long, value_delimiter = ',', default_values_t = [5000_usize, 500, 1000])]
        targets: Vec<usize>,
        #[arg(long, default_value_t = 30)]
        train_floor: usize,
        #[arg(long, default_value_t = 9)]
        variants: usize,
        #[arg(long, default_value_t = 0.10)]
        refresh_rate: f64,
        #[arg(long, default_value_t = 16)]
        batch_size: usize,
    },
    /// Import swarm writer/reader JSON answers into `<cache>/train/` and `<cache>/heldout/`.
    ImportBatches {
        #[arg(long)]
        cache: PathBuf,
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long, default_value_t = 1)]
        seed: u64,
        #[arg(long, value_delimiter = ',', default_values_t = [5000_usize, 500, 1000])]
        targets: Vec<usize>,
        #[arg(long, default_value_t = 30)]
        train_floor: usize,
    },
    /// Build a deterministic sharded data version end to end from declarations, fixture worlds,
    /// isolated phrasing caches, and runtime oracle replay.
    Build {
        #[arg(long)]
        version: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        cache: PathBuf,
        #[arg(long)]
        tokenizer: PathBuf,
        #[arg(long, default_value_t = 1)]
        seed: u64,
        #[arg(long, default_value_t = 1)]
        typo_seed: u64,
        #[arg(long)]
        offline: bool,
        #[arg(long)]
        rehearsal: bool,
        #[arg(long)]
        allow_missed_floors: bool,
        #[arg(long, default_value_t = 6)]
        concurrency: usize,
        #[command(flatten)]
        mix: MixArgs,
    },
    /// Render a staged messages directory (`--in`) and mix into a sharded data version (`--out`).
    Render {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        tokenizer: PathBuf,
        #[arg(long, default_value = "dev")]
        version: String,
        #[command(flatten)]
        mix: MixArgs,
    },
    /// Publish a built data version to two Hugging Face dataset repos (`--upload` to push; dry run default).
    Publish {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        heldout_repo: Option<String>,
        #[arg(long)]
        upload: bool,
        #[arg(long)]
        public: bool,
        #[arg(long, default_value = "python3")]
        python: String,
    },
    /// Give an older data version a `contract` block after proving its tools block against train/val.
    Restamp {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long, default_value = publish::HELDOUT_REPO)]
        heldout_repo: String,
    },
    /// Check manifest hashes and replay train/val against the current runtime.
    Drift {
        #[arg(long = "in")]
        input: PathBuf,
    },
    /// Write the byte-level test tokenizer for rehearsal runs.
    TestTokenizer {
        #[arg(long)]
        out: PathBuf,
    },
    /// Print one session of a data version with its loss mask drawn on the decoded tokens.
    Show {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        tokenizer: PathBuf,
        #[arg(long, default_value = "train")]
        split: String,
        #[arg(long)]
        session: Option<String>,
        #[arg(long, default_value_t = 240)]
        keep: usize,
    },
    /// Unpack a packed phrasing cache (`.jsonl.zst`) into `<out>/<scope>/`.
    UnpackCache {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value = "train")]
        scope: String,
    },
    /// Cut RFT records from model rollouts and render them with the data version's renderer.
    RolloutRecords {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long, value_delimiter = ',', default_value = "train")]
        split: Vec<String>,
        #[arg(long, num_args = 1.., required = true)]
        rollouts: Vec<PathBuf>,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        tokenizer: PathBuf,
        #[arg(long)]
        needs: Option<PathBuf>,
        #[arg(long, default_value_t = 5)]
        min_samples: usize,
        #[arg(long, default_value_t = 4)]
        max_copies: usize,
        #[arg(long, default_value_t = DECISION_WEIGHT)]
        decision_weight: f32,
    },
    /// Measure ambiguity on deterministic fixture worlds.
    Ambiguity {
        #[arg(long, default_value_t = 1)]
        seed: u64,
        #[arg(long, default_value = "person")]
        kind: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(clap::Args, Clone)]
struct MixArgs {
    #[arg(long, value_delimiter = ',', default_values_t = [5000_usize, 500, 1000])]
    targets: Vec<usize>,
    #[arg(long, default_value_t = DECISION_WEIGHT)]
    decision_weight: f32,
    #[arg(long, value_delimiter = ',', default_values_t = [0.40_f64, 0.30, 0.30])]
    turn_shares: Vec<f64>,
    #[arg(long, default_value_t = 0.20)]
    two_kinds: f64,
    #[arg(long, value_delimiter = ',', default_values_t = [0.65_f64, 0.08, 0.10, 0.07, 0.10])]
    outcome_shares: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_values_t = [0.45_f64, 0.45, 0.10])]
    action_shares: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_values_t = [0.40_f64, 0.25, 0.20, 0.15])]
    reference_shares: Vec<f64>,
    #[arg(long, default_value_t = 0.05)]
    impossible: f64,
    #[arg(long, default_value_t = 0.20)]
    reserved_share: f64,
    #[arg(long, value_delimiter = ',', default_values_t = [30_usize, 0, 0])]
    cell_floor: Vec<usize>,
    #[arg(long, value_delimiter = ',', default_values_t = [1000_usize, 2500])]
    subsets: Vec<usize>,
    #[arg(long, default_value_t = 8)]
    reserve: usize,
    #[arg(long, default_value_t = 1)]
    mix_seed: u64,
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

fn parse_targets(targets: &[usize]) -> Result<(usize, usize, usize)> {
    let [tr, va, te] = targets[..] else {
        anyhow::bail!("--targets takes three numbers: train,val,test");
    };
    Ok((tr, va, te))
}

fn load_prev_decls(
    path: Option<&PathBuf>,
    train_cache: &PhrasingCache,
) -> Result<Option<Declarations>> {
    if let Some(p) = path {
        let text = std::fs::read_to_string(p)
            .with_context(|| format!("reading prev declarations {}", p.display()))?;
        return Ok(Some(serde_json::from_str(&text)?));
    }
    train_cache.read_declarations()
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Catalog { out } => {
            let decls = Declarations::build()?;
            let catalog = Catalog::from_declarations(&decls);
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
            eprintln!(
                "declarations {} — {} actions",
                decls.hash(),
                decls.manifest_actions.len()
            );
        }
        Command::Declarations { out } => {
            let decls = Declarations::build()?;
            let text = serde_json::to_string_pretty(&decls)?;
            match out {
                Some(path) => {
                    std::fs::write(&path, text).with_context(|| path.display().to_string())?
                }
                None => println!("{text}"),
            }
            let (kinds, verbs, fields, actions) = decls.counts();
            eprintln!(
                "declarations {} — {kinds} kinds, {verbs} verbs, {fields} fields, {actions} manifest actions",
                decls.hash()
            );
        }
        Command::Plan {
            version,
            cache,
            seed,
            prev_declarations,
            export,
            dry_run: _,
            targets,
            train_floor,
            variants,
            refresh_rate,
            batch_size,
        } => {
            let (train_target, val_target, test_target) = parse_targets(&targets)?;
            let decls = Declarations::build()?;
            let catalog = Catalog::from_declarations(&decls);
            let pool = intents::generate_pool(
                &decls,
                seed,
                train_target,
                val_target,
                test_target,
                train_floor,
            );
            let train_cache = PhrasingCache::open(&cache, CacheScope::Train)?;
            let heldout_cache = PhrasingCache::open(&cache, CacheScope::Heldout)?;
            let prev = load_prev_decls(prev_declarations.as_ref(), &train_cache)?;
            let cfg = PlanConfig {
                version,
                train_target,
                val_target,
                test_target,
                train_floor,
                variants_per_prompt: variants,
                refresh_rate,
                batch_size,
            };
            let plan = deficit::compute_plan(
                &decls,
                prev.as_ref(),
                &catalog,
                &pool,
                &train_cache,
                &heldout_cache,
                &cfg,
            )?;
            print!("{}", plan.summary_text());
            if let Some(dir) = export {
                let n = deficit::export_batches(&plan, &dir, batch_size)?;
                eprintln!("exported {n} batch file(s) to {}", dir.display());
            }
        }
        Command::ExportBatches {
            version,
            cache,
            out,
            seed,
            prev_declarations,
            targets,
            train_floor,
            variants,
            refresh_rate,
            batch_size,
        } => {
            let (train_target, val_target, test_target) = parse_targets(&targets)?;
            let decls = Declarations::build()?;
            let catalog = Catalog::from_declarations(&decls);
            let pool = intents::generate_pool(
                &decls,
                seed,
                train_target,
                val_target,
                test_target,
                train_floor,
            );
            let train_cache = PhrasingCache::open(&cache, CacheScope::Train)?;
            let heldout_cache = PhrasingCache::open(&cache, CacheScope::Heldout)?;
            let prev = load_prev_decls(prev_declarations.as_ref(), &train_cache)?;
            let cfg = PlanConfig {
                version,
                train_target,
                val_target,
                test_target,
                train_floor,
                variants_per_prompt: variants,
                refresh_rate,
                batch_size,
            };
            let plan = deficit::compute_plan(
                &decls,
                prev.as_ref(),
                &catalog,
                &pool,
                &train_cache,
                &heldout_cache,
                &cfg,
            )?;
            let n = deficit::export_batches(&plan, &out, batch_size)?;
            print!("{}", plan.summary_text());
            eprintln!("exported {n} batch file(s) to {}", out.display());
        }
        Command::ImportBatches {
            cache,
            input,
            seed,
            targets,
            train_floor,
        } => {
            let (train_target, val_target, test_target) = parse_targets(&targets)?;
            let decls = Declarations::build()?;
            let catalog = Catalog::from_declarations(&decls);
            let pool = intents::generate_pool(
                &decls,
                seed,
                train_target,
                val_target,
                test_target,
                train_floor,
            );
            let stats = deficit::import_batches(&cache, &input, &catalog, &pool)?;
            println!("{}", serde_json::to_string_pretty(&stats)?);
        }
        Command::Build {
            version,
            out,
            cache,
            tokenizer,
            seed,
            typo_seed,
            offline,
            rehearsal,
            allow_missed_floors,
            concurrency,
            mix: mix_args,
        } => {
            let mix_cfg = mix_args.mix()?;
            let cfg = BuildConfig {
                version,
                seed,
                typo_seed,
                cache_dir: cache,
                out_dir: out,
                tokenizer,
                train_target: mix_cfg.targets[0],
                val_target: mix_cfg.targets[1],
                test_target: mix_cfg.targets[2],
                train_floor: mix_cfg.floor[0],
                offline,
                rehearsal,
                enforce_floors: !allow_missed_floors,
                decision_weight: mix_args.decision_weight,
                concurrency,
                mix_cfg,
            };
            let text = version::build_evolvable(&cfg)?;
            print!("{text}");
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
                seeds: json!({"mix": mix_args.mix_seed}),
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
        Command::Publish {
            input,
            repo,
            heldout_repo,
            upload,
            public,
            python,
        } => {
            let named = repo.as_deref().unwrap_or(publish::EXAMPLE_REPO);
            let publication = publish::prepare(&input, named, heldout_repo.as_deref())?;
            publish::verify_publish_gates(&input)?;
            if upload {
                let repo = repo.context("--upload needs --repo owner/name")?;
                heldout_repo.context("--upload needs --heldout-repo owner/name")?;
                let token = publish::token_from_env()?;
                let done = publish::upload(&publication, &repo, !public, &python, &token)?;
                println!("{done}");
            } else {
                let remote = match (repo.as_deref(), publish::token_from_env()) {
                    (Some(r), Ok(token)) => Some((
                        publish::list_remote(r, &python, &token)?,
                        publish::list_remote(&publication.heldout_repo, &python, &token)?,
                    )),
                    _ => None,
                };
                print!(
                    "{}",
                    publish::dry_run(
                        &publication,
                        repo.as_deref(),
                        !public,
                        remote.as_ref().map(|(d, h)| (d, h))
                    )
                );
            }
        }
        Command::Restamp {
            input,
            heldout_repo,
        } => {
            let (contract, proofs) = centraid_datagen::contract::restamp(&input, &heldout_repo)?;
            for p in &proofs {
                println!(
                    "proved: {} of {} {} records hold the `{}` tools block",
                    p.with_block, p.records, p.split, contract.tools_mode
                );
            }
            println!(
                "stamped {}: tools_hash {}, prompt_hash {}, catalog_hash {}, tokenizer {}; held-out repo {heldout_repo}",
                input.join("manifest.json").display(),
                contract.tools_hash,
                contract.prompt_hash,
                contract.catalog_hash,
                contract.tokenizer_blake3
            );
        }
        Command::Drift { input } => {
            print!("{}", centraid_datagen::drift::report(&input)?.text());
        }
        Command::TestTokenizer { out } => {
            std::fs::write(&out, centraid_datagen::render::byte_level_tokenizer_json())?;
            eprintln!("wrote {}", out.display());
        }
        Command::Show {
            input,
            tokenizer,
            split,
            session,
            keep,
        } => {
            let tokenizer = centraid_datagen::render::Tokenizer::open(&tokenizer)?;
            let mut paths = version::split_paths(&input, &split);
            if paths.is_empty() {
                paths.push(version::split_path(&input, &split));
            }
            let mut found = None;
            for path in paths {
                let bytes = zstd::stream::decode_all(
                    std::fs::File::open(&path).with_context(|| path.display().to_string())?,
                )?;
                let text = String::from_utf8(bytes)?;
                for line in text.lines().filter(|l| !l.trim().is_empty()) {
                    let r: Value = serde_json::from_str(line)?;
                    if session.as_deref().is_none_or(|id| r["id"] == id) {
                        found = Some(r);
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            let record = found.context("no such session")?;
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
        Command::UnpackCache { input, out, scope } => {
            let cache_scope = if scope == "heldout" {
                CacheScope::Heldout
            } else {
                CacheScope::Train
            };
            let cache = PhrasingCache::open(&out, cache_scope)?;
            let n = cache.unpack(&input)?;
            eprintln!(
                "unpacked {n} phrasing cache entries into {}",
                cache.dir().display()
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
        Command::Ambiguity { seed, kind, json } => {
            let mut rows: Vec<(String, Ambiguity)> = Vec::new();
            for split in Split::ALL {
                let mut req = FixtureRequest::simple(split, seed, &kind);
                req.with_distractor = true;
                let (world, _) = fixture_world::build(&req);
                let measured = ambiguity::measure(&world);
                rows.push((world.id, measured));
            }
            if json {
                println!("{}", serde_json::to_string_pretty(&rows)?);
            } else {
                for (id, a) in &rows {
                    println!(
                        "{id}: rows={} exact_groups={} near_pairs={} confusable={}",
                        a.totals.rows,
                        a.totals.exact_name_groups,
                        a.totals.near_duplicate_pairs,
                        a.totals.confusable_rows
                    );
                }
            }
        }
    }
    Ok(())
}
