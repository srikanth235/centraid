//! `assist-eval rollout …`: sample k decodes over a set, report them, compare two reports, cut RFT/DPO records.
//!
//! ```text
//! assist-eval rollout         (--model GGUF | --stub) --set SET.jsonl [--worlds DIR]… --out PREFIX [--k 4] [--temperature 0.6]
//!                             [--top-p 0.95] [--seed N] [--grammar off|handles|full] [--tools sig|s2|…] [--limit N] [--only ID,ID]
//!                             [--shard K/N] [--resume] [--threads N] [--gpu-layers N] [--label TEXT]
//! assist-eval rollout-report  --rollouts PREFIX.rollouts.jsonl… --out PREFIX [--label TEXT]
//! assist-eval rollout-compare BEFORE.rollout.json AFTER.rollout.json [--out FILE.json]
//! assist-eval rollout-records --rollouts PREFIX.rollouts.jsonl… --set SET.jsonl [--worlds DIR]… --out DIR
//!                             [--needs REPORT.json] [--min-samples 5] [--max-copies 4] [--pairs-per-turn 2]
//! ```

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use centraid_assist::native::grammar::GrammarMode;
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::EvalError;
use centraid_assist_eval::rollout::records::{self, Needs, RecordStats, Weighing};
use centraid_assist_eval::rollout::report::{self, RolloutReport};
use centraid_assist_eval::rollout::{Rollout, Sampling, run_rollouts};
use centraid_assist_eval::run::{DeclineStepper, Runner, Stepper};
use centraid_assist_eval::source::{EvalSource, JsonlSource};
use centraid_assist_eval::tally::{WithoutInProgress, WithoutTally};

#[derive(Default)]
struct Flags {
    model: Option<PathBuf>,
    stub: bool,
    set: Option<PathBuf>,
    worlds: Vec<PathBuf>,
    out: Option<PathBuf>,
    rollouts: Vec<PathBuf>,
    needs: Option<PathBuf>,
    positional: Vec<PathBuf>,
    k: Option<usize>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    seed: Option<u64>,
    grammar: Option<String>,
    tools: Option<String>,
    limit: Option<usize>,
    only: Vec<String>,
    shard: Option<(usize, usize)>,
    resume: bool,
    threads: Option<i32>,
    gpu_layers: Option<u32>,
    label: Option<String>,
    min_samples: Option<usize>,
    max_copies: Option<usize>,
    pairs_per_turn: Option<usize>,
}

fn flags(argv: &[String]) -> Result<Flags> {
    let mut out = Flags {
        model: std::env::var_os("ASSIST_EVAL_MODEL").map(PathBuf::from),
        threads: std::env::var("ASSIST_EVAL_THREADS")
            .ok()
            .and_then(|t| t.parse().ok()),
        gpu_layers: std::env::var("ASSIST_EVAL_GPU_LAYERS")
            .ok()
            .and_then(|n| n.parse().ok()),
        ..Flags::default()
    };
    let mut it = argv.iter();
    while let Some(flag) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .with_context(|| format!("{name} takes a value"))
        };
        match flag.as_str() {
            "--model" => out.model = Some(value("--model")?.into()),
            "--stub" => out.stub = true,
            "--set" => out.set = Some(value("--set")?.into()),
            "--worlds" => out.worlds.push(value("--worlds")?.into()),
            "--out" => out.out = Some(value("--out")?.into()),
            "--rollouts" => out.rollouts.push(value("--rollouts")?.into()),
            "--needs" => out.needs = Some(value("--needs")?.into()),
            "--k" => out.k = Some(value("--k")?.parse().context("--k N")?),
            "--temperature" => {
                out.temperature = Some(value("--temperature")?.parse().context("--temperature X")?)
            }
            "--top-p" => out.top_p = Some(value("--top-p")?.parse().context("--top-p X")?),
            "--seed" => out.seed = Some(value("--seed")?.parse().context("--seed N")?),
            "--grammar" => out.grammar = Some(value("--grammar")?),
            "--tools" => out.tools = Some(value("--tools")?),
            "--limit" => out.limit = Some(value("--limit")?.parse().context("--limit N")?),
            "--only" => out.only = value("--only")?.split(',').map(str::to_owned).collect(),
            "--shard" => {
                let text = value("--shard")?;
                let (k, n) = text.split_once('/').context("--shard K/N")?;
                let (k, n): (usize, usize) = (
                    k.parse().context("--shard K/N")?,
                    n.parse().context("--shard K/N")?,
                );
                if n == 0 || k >= n {
                    bail!("--shard K/N counts from 0: K < N");
                }
                out.shard = Some((k, n));
            }
            "--resume" => out.resume = true,
            "--threads" => out.threads = Some(value("--threads")?.parse().context("--threads N")?),
            "--gpu-layers" => {
                out.gpu_layers = Some(value("--gpu-layers")?.parse().context("--gpu-layers N")?)
            }
            "--label" => out.label = Some(value("--label")?),
            "--min-samples" => {
                out.min_samples = Some(value("--min-samples")?.parse().context("--min-samples N")?)
            }
            "--max-copies" => {
                out.max_copies = Some(value("--max-copies")?.parse().context("--max-copies N")?)
            }
            "--pairs-per-turn" => {
                out.pairs_per_turn = Some(
                    value("--pairs-per-turn")?
                        .parse()
                        .context("--pairs-per-turn N")?,
                )
            }
            other if !other.starts_with("--") => out.positional.push(other.into()),
            other => bail!("unknown argument {other}"),
        }
    }
    Ok(out)
}

fn tools_of(word: &str) -> Result<ToolsMode> {
    Ok(match word {
        "s2" => ToolsMode::S2,
        "sig" => ToolsMode::Sig,
        "compact" => ToolsMode::Compact,
        "full" => ToolsMode::Full,
        other => bail!("--tools takes s2, sig, compact or full, not {other}"),
    })
}

fn grammar_of(word: &str) -> Result<GrammarMode> {
    Ok(match word {
        "off" => GrammarMode::Off,
        "handles" => GrammarMode::Handles,
        "full" => GrammarMode::Full,
        other => bail!("--grammar takes off, handles or full, not {other}"),
    })
}

fn with_ext(prefix: &Path, ext: &str) -> PathBuf {
    let mut name = prefix.as_os_str().to_os_string();
    name.push(".");
    name.push(ext);
    PathBuf::from(name)
}

fn source(f: &Flags, native: &Path) -> Result<impl EvalSource> {
    let set = f.set.clone().context("give --set SET.jsonl")?;
    let worlds = if f.worlds.is_empty() {
        vec![native.join("eval/worlds"), native.join("authored/worlds")]
    } else {
        f.worlds.clone()
    };
    Ok(WithoutInProgress::new(WithoutTally::new(JsonlSource::new(
        set, worlds,
    ))))
}

fn read_rollouts(files: &[PathBuf]) -> Result<Vec<Rollout>> {
    let mut out = Vec::new();
    for path in files {
        for line in std::fs::read_to_string(path)
            .with_context(|| path.display().to_string())?
            .lines()
        {
            if !line.trim().is_empty() {
                out.push(
                    serde_json::from_str::<Rollout>(line)
                        .with_context(|| path.display().to_string())?,
                );
            }
        }
    }
    Ok(out)
}

fn write_report(prefix: Option<&PathBuf>, report: &RolloutReport) -> Result<()> {
    print!("{}", report::text(report));
    if let Some(prefix) = prefix {
        std::fs::write(
            with_ext(prefix, "rollout.json"),
            serde_json::to_string_pretty(report)?,
        )?;
    }
    Ok(())
}

pub fn run(command: &str, argv: &[String]) -> Result<()> {
    let f = flags(argv)?;
    match command {
        "rollout" => sample(&f),
        "rollout-report" => {
            let rollouts = read_rollouts(&f.rollouts)?;
            let label = f
                .label
                .clone()
                .unwrap_or_else(|| format!("rescored:{}", f.rollouts.len()));
            write_report(f.out.as_ref(), &report::build(&label, "", None, &rollouts))
        }
        "rollout-compare" => {
            let [before, after] = f.positional.as_slice() else {
                bail!("rollout-compare BEFORE.rollout.json AFTER.rollout.json");
            };
            let load = |p: &PathBuf| -> Result<RolloutReport> {
                serde_json::from_str(
                    &std::fs::read_to_string(p).with_context(|| p.display().to_string())?,
                )
                .with_context(|| p.display().to_string())
            };
            let comparison = report::compare(&load(before)?, &load(after)?);
            print!("{}", report::compare_text(&comparison));
            if let Some(out) = &f.out {
                std::fs::write(out, serde_json::to_string_pretty(&comparison)?)?;
            }
            Ok(())
        }
        "rollout-records" => cut_records(&f),
        other => bail!("unknown command {other}"),
    }
}

fn sample(f: &Flags) -> Result<()> {
    let native = PathBuf::from("experiments/toolchat/native");
    let source = source(f, &native)?;
    let tools = tools_of(f.tools.as_deref().unwrap_or("sig"))?;
    let grammar = grammar_of(f.grammar.as_deref().unwrap_or("full"))?;
    let sampling = Sampling {
        k: f.k.unwrap_or(4),
        temperature: f.temperature.unwrap_or(0.6),
        top_p: f.top_p.unwrap_or(0.95),
        seed: f.seed.unwrap_or(0),
        grammar: grammar.name().to_owned(),
        tools: format!("{tools:?}").to_lowercase(),
    };
    if sampling.k == 0 {
        bail!("--k must be at least 1");
    }
    let mut sessions = source.sessions()?;
    if !f.only.is_empty() {
        sessions.retain(|s| f.only.contains(&s.id));
    }
    if let Some((k, n)) = f.shard {
        sessions = sessions
            .into_iter()
            .enumerate()
            .filter(|(i, _)| i % n == k)
            .map(|(_, s)| s)
            .collect();
    }
    if let Some(limit) = f.limit {
        sessions.truncate(limit);
    }
    #[cfg(feature = "engine")]
    let loaded;
    let (label, stepper): (String, Box<dyn Stepper>) = if f.stub {
        ("stub:decline".to_owned(), Box::new(DeclineStepper))
    } else {
        #[cfg(feature = "engine")]
        {
            let path = f
                .model
                .clone()
                .context("give --model GGUF (or ASSIST_EVAL_MODEL), or --stub")?;
            loaded = super::engine(
                &path,
                f.threads,
                f.gpu_layers,
                sampling.top_p,
                sampling.seed,
            )?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut stepper = centraid_assist_eval::run::ModelStepper::new(loaded.as_ref());
            stepper.options.temperature = sampling.temperature;
            stepper.options.grammar = grammar;
            (
                format!(
                    "gguf:{name}[tools={},grammar={}]",
                    sampling.tools, sampling.grammar
                ),
                Box::new(stepper),
            )
        }
        #[cfg(not(feature = "engine"))]
        {
            bail!("built without llama.cpp: rebuild with --features engine, or pass --stub");
        }
    };
    let label = f.label.clone().unwrap_or(label);
    let mut runner = Runner::new(&source, stepper.as_ref())?.with_tools(tools);
    let file = f.out.as_ref().map(|p| with_ext(p, "rollouts.jsonl"));
    let mut all: Vec<Rollout> = Vec::new();
    if let Some(file) = file.as_ref().filter(|p| f.resume && p.exists()) {
        for line in std::fs::read_to_string(file)?.lines() {
            if let Ok(done) = serde_json::from_str::<Rollout>(line) {
                all.push(done);
            }
        }
        // a session counts as done only with all its k samples; a torn tail is rerun whole
        let whole: std::collections::BTreeSet<String> = sessions
            .iter()
            .filter(|s| all.iter().filter(|r| r.result.id == s.id).count() >= sampling.k)
            .map(|s| s.id.clone())
            .collect();
        all.retain(|r| whole.contains(&r.result.id));
        sessions.retain(|s| !whole.contains(&s.id));
        eprintln!("resuming: {} sessions already done", whole.len());
    }
    let mut sink = match &file {
        Some(p) if f.resume => {
            let mut out = std::fs::File::create(p)?;
            for r in &all {
                writeln!(out, "{}", serde_json::to_string(r)?)?;
            }
            Some(out)
        }
        Some(p) => Some(std::fs::File::create(p)?),
        None => None,
    };
    let total = sessions.len();
    for (i, session) in sessions.iter().enumerate() {
        let done = match run_rollouts(&mut runner, session, sampling.k) {
            Ok(done) => done,
            Err(error @ (EvalError::Data(_) | EvalError::Json { .. } | EvalError::Read { .. })) => {
                eprintln!("[{}/{}] {} left out: {error}", i + 1, total, session.id);
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        eprintln!(
            "[{}/{}] {} {}/{} samples pass",
            i + 1,
            total,
            session.id,
            done.iter().filter(|r| r.result.pass()).count(),
            done.len()
        );
        for r in done {
            if let Some(out) = sink.as_mut() {
                writeln!(out, "{}", serde_json::to_string(&r)?)?;
            }
            all.push(r);
        }
    }
    write_report(
        f.out.as_ref(),
        &report::build(&label, &source.label(), Some(sampling), &all),
    )
}

fn cut_records(f: &Flags) -> Result<()> {
    let native = PathBuf::from("experiments/toolchat/native");
    let source = source(f, &native)?;
    let out = f.out.clone().context("give --out DIR")?;
    let rollouts = read_rollouts(&f.rollouts)?;
    let sessions = source.sessions()?;
    let needs = match &f.needs {
        Some(path) => Needs::from_report(
            &serde_json::from_str(
                &std::fs::read_to_string(path).with_context(|| path.display().to_string())?,
            )?,
            f.min_samples.unwrap_or(5),
        ),
        None => Needs::default(),
    };
    let how = Weighing {
        max_copies: f.max_copies.unwrap_or(4),
        ..Weighing::default()
    };
    let mut stats = RecordStats::default();
    let rft = records::rft_records(&sessions, &rollouts, &needs, how, &mut stats);
    let pairs = records::dpo_pairs(
        &sessions,
        &rollouts,
        f.pairs_per_turn.unwrap_or(2),
        &mut stats,
    );
    // TODO(M4): render with the data version's renderer (`records::RenderRecord`) before writing; until it lands the
    // lines carry no `render` and the trainer cannot read them.
    std::fs::create_dir_all(&out)?;
    let mut file = std::fs::File::create(out.join("rft.jsonl"))?;
    for r in &rft {
        writeln!(file, "{}", serde_json::to_string(r)?)?;
    }
    let mut file = std::fs::File::create(out.join("dpo.jsonl"))?;
    for p in &pairs {
        writeln!(file, "{}", serde_json::to_string(p)?)?;
    }
    std::fs::write(
        out.join("stats.json"),
        serde_json::to_string_pretty(&stats)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&stats)?);
    eprintln!("records are UNRENDERED (no `render`): the M4 renderer is not wired in yet");
    Ok(())
}
