//! `assist-eval` — score a model over a held-out set, through the phone's decode step.
//!
//! ```text
//! cargo build --release -p centraid-assist-eval --features engine --bin assist-eval
//! assist-eval --model native-s2-Q4_0.gguf --set experiments/toolchat/native/data/v7/val.jsonl --out runs/val-s2
//! assist-eval --stub --set … --worlds …        # no weights: a model that declines everything
//! ```
//!
//! Writes `<out>.json` (the report) and `<out>.sessions.jsonl` (every turn's result, one session per line), and
//! prints the summary. `--worlds DIR` may repeat; the default is the two directories the Python eval reads. Several
//! processes can share a set with `--shard K/N` (each loads the model: ~0.6 GB at Q4_0); merge by scoring each
//! `.sessions.jsonl` with `--rescore`.

#[path = "assist-eval/rollout_cmd.rs"]
mod rollout_cmd;

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::EvalError;
use centraid_assist_eval::report;
use centraid_assist_eval::run::{DeclineStepper, Runner, SessionResult, Stepper};
use centraid_assist_eval::source::{EvalSource, Exclusion, JsonlSource};
use centraid_assist_eval::tally::{WithoutInProgress, WithoutTally};

struct Args {
    model: Option<PathBuf>,
    stub: bool,
    set: PathBuf,
    worlds: Vec<PathBuf>,
    out: Option<PathBuf>,
    threads: Option<i32>,
    limit: Option<usize>,
    only: Vec<String>,
    shard: Option<(usize, usize)>,
    rescore: Vec<PathBuf>,
    tools: ToolsMode,
    resume: bool,
    gpu_layers: Option<u32>,
    label: Option<String>,
}

const USAGE: &str = "usage: assist-eval (--model GGUF | --stub) --set SET.jsonl [--worlds DIR]… [--out PREFIX] \
[--tools s2|sig|compact|full] [--threads N] [--limit N] [--only ID,ID] [--shard K/N] [--resume] [--gpu-layers N] [--label TEXT]\n       assist-eval --rescore RUN.sessions.jsonl… --set SET.jsonl [--out PREFIX]";

fn args() -> Result<Args> {
    let native = PathBuf::from("experiments/toolchat/native");
    let mut out = Args {
        model: std::env::var_os("ASSIST_EVAL_MODEL").map(PathBuf::from),
        stub: false,
        set: native.join("data/v7/val.jsonl"),
        worlds: Vec::new(),
        out: None,
        threads: std::env::var("ASSIST_EVAL_THREADS")
            .ok()
            .and_then(|t| t.parse().ok()),
        limit: None,
        only: Vec::new(),
        shard: None,
        rescore: Vec::new(),
        // the eight tools; `--tools s2` scores the model shipping today
        tools: ToolsMode::Sig,
        resume: false,
        label: None,
        gpu_layers: std::env::var("ASSIST_EVAL_GPU_LAYERS")
            .ok()
            .and_then(|n| n.parse().ok()),
    };
    let mut argv = std::env::args().skip(1);
    while let Some(flag) = argv.next() {
        let mut value = |name: &str| {
            argv.next()
                .with_context(|| format!("{name} takes a value\n{USAGE}"))
        };
        match flag.as_str() {
            "--model" => out.model = Some(value("--model")?.into()),
            "--stub" => out.stub = true,
            "--set" => out.set = value("--set")?.into(),
            "--worlds" => out.worlds.push(value("--worlds")?.into()),
            "--out" => out.out = Some(value("--out")?.into()),
            "--threads" => out.threads = Some(value("--threads")?.parse().context("--threads N")?),
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
            "--tools" => {
                let word = value("--tools")?;
                out.tools = match word.as_str() {
                    "s2" => ToolsMode::S2,
                    "sig" => ToolsMode::Sig,
                    "compact" => ToolsMode::Compact,
                    "full" => ToolsMode::Full,
                    other => bail!("--tools takes s2, sig, compact or full, not {other}"),
                };
            }
            "--resume" => out.resume = true,
            "--label" => out.label = Some(value("--label")?),
            "--gpu-layers" => {
                out.gpu_layers = Some(value("--gpu-layers")?.parse().context("--gpu-layers N")?)
            }
            "--rescore" => out.rescore.push(value("--rescore")?.into()),
            other => bail!("unknown argument {other}\n{USAGE}"),
        }
    }
    if out.worlds.is_empty() {
        out.worlds = vec![native.join("data/v7/worlds")];
    }
    Ok(out)
}

#[cfg(feature = "engine")]
fn engine(
    path: &std::path::Path,
    threads: Option<i32>,
    gpu_layers: Option<u32>,
    top_p: f32,
    seed: u64,
) -> Result<std::sync::Arc<dyn centraid_assist::Model>> {
    use centraid_assist::host::ModelLoader;
    use centraid_assist_llama::{Config, LlamaLoader};
    // the phone's context for a step is the eval's: the longest rendered prompt plus a message must fit
    let mut config = Config {
        context: 8192,
        threads,
        logs: false,
        top_p,
        seed,
        ..Config::default()
    };
    if let Some(layers) = gpu_layers {
        config.gpu_layers = layers;
    }
    LlamaLoader::new(config)
        .load(path)
        .map_err(|error| anyhow::anyhow!("loading {}: {error}", path.display()))
}

fn run() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Some(command) = argv.first().filter(|c| c.starts_with("rollout")) {
        return rollout_cmd::run(command, &argv[1..]);
    }
    let args = args()?;
    // the held-out worlds predate the vault rebuild: Tally and the `in_progress` status are gone from the runtime.
    // The wrappers read them out and the report counts the sessions this leaves out
    let source = WithoutInProgress::new(WithoutTally::new(JsonlSource::new(
        &args.set,
        args.worlds.clone(),
    )));
    let prefix = args.out.clone();
    let mut set_total = None;
    let (label, results, skipped) = if args.rescore.is_empty() {
        let mut sessions = source.sessions()?;
        set_total = Some(sessions.len() + source.excluded()?.len());
        if !args.only.is_empty() {
            sessions.retain(|s| args.only.contains(&s.id));
        }
        if let Some((k, n)) = args.shard {
            sessions = sessions
                .into_iter()
                .enumerate()
                .filter(|(i, _)| i % n == k)
                .map(|(_, s)| s)
                .collect();
        }
        if let Some(limit) = args.limit {
            sessions.truncate(limit);
        }
        #[cfg(feature = "engine")]
        let loaded;
        let (label, stepper): (String, Box<dyn Stepper>) = if args.stub {
            (
                format!("stub:decline[tools={:?}]", args.tools).to_lowercase(),
                Box::new(DeclineStepper),
            )
        } else {
            let path = args
                .model
                .clone()
                .context("give --model GGUF (or ASSIST_EVAL_MODEL), or --stub")?;
            #[cfg(feature = "engine")]
            {
                loaded = engine(&path, args.threads, args.gpu_layers, 1.0, 0)?;
                let sha = std::process::Command::new("shasum")
                    .args(["-a", "256"])
                    .arg(&path)
                    .output()
                    .ok();
                let sha = sha
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.chars().take(12).collect::<String>())
                    .unwrap_or_default();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                (
                    format!("gguf:{name}@{sha}[tools={:?}]", args.tools).to_lowercase(),
                    Box::new(centraid_assist_eval::run::ModelStepper::new(
                        loaded.as_ref(),
                    )),
                )
            }
            #[cfg(not(feature = "engine"))]
            {
                let _ = (path, args.threads, args.gpu_layers);
                bail!("built without llama.cpp: rebuild with --features engine, or pass --stub");
            }
        };
        let mut runner = Runner::new(&source, stepper.as_ref())?.with_tools(args.tools);
        let started = Instant::now();
        let mut results: Vec<SessionResult> = Vec::new();
        let file = prefix.as_ref().map(|p| with_ext(p, "sessions.jsonl"));
        if let Some(file) = file.as_ref().filter(|f| args.resume && f.exists()) {
            // a restart picks up where the run stopped; a line cut off by the kill is read as not done
            for line in std::fs::read_to_string(file)?.lines() {
                if let Ok(done) = serde_json::from_str::<SessionResult>(line) {
                    results.push(done);
                }
            }
            sessions.retain(|s| !results.iter().any(|r| r.id == s.id));
            eprintln!("resuming: {} sessions already done", results.len());
        }
        let total = sessions.len();
        let mut skipped: Vec<Exclusion> = Vec::new();
        let mut sink = match &file {
            Some(f) if args.resume => {
                // rewrite the lines that parsed, then append: a torn last line must not stay
                let mut out = std::fs::File::create(f)?;
                for done in &results {
                    writeln!(out, "{}", serde_json::to_string(done)?)?;
                }
                Some(out)
            }
            Some(f) => Some(std::fs::File::create(f)?),
            None => None,
        };
        for (i, session) in sessions.iter().enumerate() {
            let result = match runner.run_session(session) {
                Ok(result) => result,
                // one session the data cannot seed or judge is left out and counted; it must not end the run
                Err(
                    error @ (EvalError::Data(_) | EvalError::Json { .. } | EvalError::Read { .. }),
                ) => {
                    eprintln!("[{}/{}] {} left out: {error}", i + 1, total, session.id);
                    skipped.push(Exclusion {
                        id: session.id.clone(),
                        reason: error.to_string(),
                    });
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            eprintln!(
                "[{}/{}] {} {} ({} ms, {:.0}s elapsed)",
                i + 1,
                total,
                session.id,
                if result.pass() { "pass" } else { "FAIL" },
                result.ms,
                started.elapsed().as_secs_f64()
            );
            if let Some(file) = sink.as_mut() {
                writeln!(file, "{}", serde_json::to_string(&result)?)?;
            }
            results.push(result);
        }
        (label, results, skipped)
    } else {
        let mut results = Vec::new();
        for path in &args.rescore {
            for line in std::fs::read_to_string(path)
                .with_context(|| path.display().to_string())?
                .lines()
            {
                if !line.trim().is_empty() {
                    results.push(serde_json::from_str::<SessionResult>(line)?);
                }
            }
        }
        (
            args.label
                .clone()
                .unwrap_or_else(|| format!("rescored:{}", args.rescore.len())),
            results,
            Vec::new(),
        )
    };
    let mut excluded = source.excluded()?;
    excluded.extend(skipped);
    let report = report::build(
        &label,
        &source.label(),
        &results,
        &excluded,
        set_total.unwrap_or(results.len() + excluded.len()),
    );
    print!("{}", report::text(&report));
    if let Some(prefix) = prefix {
        let json = serde_json::to_string_pretty(&report)?;
        std::fs::write(with_ext(&prefix, "json"), json)?;
    }
    Ok(())
}

fn with_ext(prefix: &std::path::Path, ext: &str) -> PathBuf {
    let mut name = prefix.as_os_str().to_os_string();
    name.push(".");
    name.push(ext);
    PathBuf::from(name)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("assist-eval: {error:#}");
            ExitCode::FAILURE
        }
    }
}
