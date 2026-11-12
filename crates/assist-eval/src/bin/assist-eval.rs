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
use centraid_assist::native::grammar::GrammarMode;
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::EvalError;
use centraid_assist_eval::compare;
use centraid_assist_eval::report::{self, RunConfig};
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
    tools_given: bool,
    /// An adapter GGUF loaded beside the base (`--adapter`).
    adapter: Option<PathBuf>,
    /// `None`: the phone's (`native_turn::phone_options`)
    grammar: Option<GrammarMode>,
    resume: bool,
    gpu_layers: Option<u32>,
    label: Option<String>,
}

const USAGE: &str = "usage: assist-eval (--model GGUF | --stub) --set SET.jsonl [--worlds DIR]… [--out PREFIX] \
[--tools s2|sig|compact|full] [--grammar off|handles|full] [--adapter GGUF] [--threads N] [--limit N] [--only ID,ID] [--shard K/N] [--resume] [--gpu-layers N] [--label TEXT]\n       assist-eval --rescore RUN.sessions.jsonl… --set SET.jsonl [--out PREFIX] [--tools …] [--grammar …]\n       assist-eval replay --set SET.jsonl [--worlds DIR]… [--tools …]   (the reference calls must replay to 100%)\n       assist-eval compare A.json B.json [--out FILE.json]   (B against the baseline A, paired by session)";

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
        // the phone's tools block (the model record's), like its grammar
        tools: centraid_assist::native_turn::phone_options().tools,
        tools_given: false,
        adapter: None,
        grammar: None,
        resume: false,
        label: None,
        gpu_layers: std::env::var("ASSIST_EVAL_GPU_LAYERS")
            .ok()
            .and_then(|n| n.parse().ok()),
    };
    let mut argv = std::env::args().skip(1).peekable();
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
            "--adapter" => out.adapter = Some(value("--adapter")?.into()),
            "--tools" => {
                out.tools_given = true;
                out.tools = tools_of(&value("--tools")?)?;
            }
            "--grammar" => out.grammar = Some(rollout_cmd::grammar_of(&value("--grammar")?)?),
            "--resume" => out.resume = true,
            "--label" => out.label = Some(value("--label")?),
            "--gpu-layers" => {
                out.gpu_layers = Some(value("--gpu-layers")?.parse().context("--gpu-layers N")?)
            }
            "--rescore" => {
                // one or more files: the shards of a run
                out.rescore.push(value("--rescore")?.into());
                while let Some(file) = argv.next_if(|a| !a.starts_with("--")) {
                    out.rescore.push(file.into());
                }
            }
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
    match argv.first().map(String::as_str) {
        Some("compare") => return compare_cmd(&argv[1..]),
        Some("replay") => return replay_cmd(&argv[1..]),
        _ => {}
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
    let word = |mode: ToolsMode| format!("{mode:?}").to_lowercase();
    let mut config = RunConfig::default();
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
        // THE PRECONDITION: the reference calls of these very sessions must replay to their gold through the same
        // runner and judge, or no model is asked (a set the runtime cannot solve scores nothing)
        let replayed = centraid_assist_eval::replay::require(&source, &sessions, args.tools)?;
        eprintln!(
            "reference replay: {} sessions, {} turns, 100%",
            replayed.sessions, replayed.turns
        );
        // the phone's grammar unless asked otherwise: the number reported is the number the phone would get
        let grammar = args
            .grammar
            .unwrap_or_else(|| centraid_assist::native_turn::phone_options().grammar);
        config.tools = Some(word(args.tools));
        config.grammar = Some(grammar.name().to_owned());
        let settings = format!("tools={},grammar={}", word(args.tools), grammar.name());
        #[cfg(feature = "engine")]
        let loaded;
        let (label, stepper): (String, Box<dyn Stepper>) = if args.stub {
            if args.adapter.is_some() {
                bail!(
                    "--adapter needs a model: it is loaded beside the base GGUF, and --stub has none"
                );
            }
            (
                format!("stub:decline[{settings}]"),
                Box::new(DeclineStepper),
            )
        } else {
            let path = args
                .model
                .clone()
                .context("give --model GGUF (or ASSIST_EVAL_MODEL), or --stub")?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // the label names exactly what ran: the base and the adapter, each by the hash of its bytes
            let base = sha256_of(&path)?;
            let mut label = format!("gguf:{name}@{}", &base[..12]);
            config.model_sha256 = Some(base);
            if let Some(adapter) = &args.adapter {
                let sha = sha256_of(adapter)?;
                label += &format!(
                    "+adapter:{}@{}",
                    adapter
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    &sha[..12]
                );
                config.adapter_sha256 = Some(sha);
                bail_until_the_engine_loads_adapters(adapter)?;
            }
            label += &format!("[{settings}]");
            #[cfg(feature = "engine")]
            {
                loaded = engine(&path, args.threads, args.gpu_layers, 1.0, 0)?;
                let mut stepper = centraid_assist_eval::run::ModelStepper::new(loaded.as_ref());
                stepper.options.grammar = grammar;
                (label, Box::new(stepper))
            }
            #[cfg(not(feature = "engine"))]
            {
                let _ = (label, args.threads, args.gpu_layers);
                bail!("built without llama.cpp: rebuild with --features engine, or pass --stub");
            }
        };
        if let Some(prefix) = &prefix {
            // what a rescore of this run's sessions file reads back, so a merge needs no flags and cannot guess
            let sidecar = Sidecar {
                label: label.clone(),
                config: config.clone(),
            };
            std::fs::write(
                with_ext(prefix, "config.json"),
                serde_json::to_string_pretty(&sidecar)?,
            )?;
        }
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
        // a rescore takes how the runs decoded from the `.config.json` beside each sessions file (every one must say
        // the same), else from the flags, else it stays unknown: nothing is guessed
        let mut found: Vec<Sidecar> = Vec::new();
        for path in &args.rescore {
            let name = path.to_string_lossy();
            if let Some(stem) = name.strip_suffix(".sessions.jsonl")
                && let Ok(text) = std::fs::read_to_string(format!("{stem}.config.json"))
            {
                found.push(
                    serde_json::from_str(&text).with_context(|| format!("{stem}.config.json"))?,
                );
            }
        }
        let mut sidecar_label = None;
        if let Some(first) = found.first() {
            if found.len() != args.rescore.len() {
                bail!(
                    "only {} of {} sessions files have a .config.json beside them",
                    found.len(),
                    args.rescore.len()
                );
            }
            if found.iter().any(|f| f.config != first.config) {
                bail!(
                    "the sessions files were made under different settings (their .config.json differ): not one run"
                );
            }
            config = first.config.clone();
            sidecar_label = Some(first.label.clone());
        }
        if args.tools_given {
            config.tools = Some(word(args.tools));
        }
        if let Some(grammar) = args.grammar {
            config.grammar = Some(grammar.name().to_owned());
        }
        (
            args.label
                .clone()
                .or(sidecar_label)
                .unwrap_or_else(|| format!("rescored:{}", args.rescore.len())),
            results,
            Vec::new(),
        )
    };
    let mut excluded = source.excluded()?;
    excluded.extend(skipped);
    let label = if label.contains("[tools=") || args.rescore.is_empty() {
        label
    } else {
        format!(
            "{label}[tools={},grammar={}]",
            config.tools.as_deref().unwrap_or("?"),
            config.grammar.as_deref().unwrap_or("?")
        )
    };
    let report = report::build(
        &label,
        &source.label(),
        &results,
        &excluded,
        set_total.unwrap_or(results.len() + excluded.len()),
    )
    .with_config(config);
    print!("{}", report::text(&report));
    if let Some(prefix) = prefix {
        let json = serde_json::to_string_pretty(&report)?;
        std::fs::write(with_ext(&prefix, "json"), json)?;
    }
    Ok(())
}

/// What a run writes beside its sessions file, `PREFIX.config.json`.
#[derive(serde::Serialize, serde::Deserialize)]
struct Sidecar {
    label: String,
    config: RunConfig,
}

/// The sha256 of a file, hex, read in a stream.
fn sha256_of(path: &std::path::Path) -> Result<String> {
    use std::io::Read;

    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).with_context(|| path.display().to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let n = file
            .read(&mut buffer)
            .with_context(|| path.display().to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// The seam for `--adapter`. The engine (`centraid-assist-llama`) does not load an adapter beside the base yet: that
/// is its own change (#1188, Part E). Until it lands the flag refuses with this message, and nothing is scored under a
/// label that claims an adapter the run did not use. The report already records the adapter's sha256.
fn bail_until_the_engine_loads_adapters(adapter: &std::path::Path) -> Result<()> {
    bail!(
        "--adapter {}: this engine cannot load an adapter beside the base GGUF yet, so a run would score the base model \
         under the adapter's name. Nothing was run",
        adapter.display()
    )
}

fn compare_cmd(argv: &[String]) -> Result<()> {
    let mut files = Vec::new();
    let mut out = None;
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--out" => out = Some(PathBuf::from(it.next().context("--out takes a value")?)),
            other if !other.starts_with("--") => files.push(PathBuf::from(other)),
            other => bail!("unknown argument {other}\n{USAGE}"),
        }
    }
    let [a, b] = files.as_slice() else {
        bail!("compare takes two reports, A (the baseline) and B (the candidate)\n{USAGE}");
    };
    let (a, b) = (
        compare::Comparable::read(a).map_err(anyhow::Error::msg)?,
        compare::Comparable::read(b).map_err(anyhow::Error::msg)?,
    );
    let comparison = compare::compare(&a, &b).map_err(anyhow::Error::msg)?;
    print!("{}", comparison.text());
    if let Some(out) = out {
        std::fs::write(out, serde_json::to_string_pretty(&comparison)?)?;
    }
    Ok(())
}

/// `assist-eval replay`: only the precondition, with no model.
fn replay_cmd(argv: &[String]) -> Result<()> {
    let mut set = PathBuf::from("experiments/toolchat/native/data/v7/val.jsonl");
    let mut worlds = Vec::new();
    let mut tools = centraid_assist::native_turn::phone_options().tools;
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().with_context(|| format!("{name} takes a value"));
        match arg.as_str() {
            "--set" => set = value("--set")?.into(),
            "--worlds" => worlds.push(PathBuf::from(value("--worlds")?)),
            "--tools" => tools = tools_of(value("--tools")?)?,
            other => bail!("unknown argument {other}\n{USAGE}"),
        }
    }
    if worlds.is_empty() {
        worlds = vec![PathBuf::from("experiments/toolchat/native/data/v7/worlds")];
    }
    let source = WithoutInProgress::new(WithoutTally::new(JsonlSource::new(&set, worlds)));
    let sessions = source.sessions()?;
    let report = centraid_assist_eval::replay::require(&source, &sessions, tools)?;
    println!(
        "reference replay: {} sessions, {} turns, 100%",
        report.sessions, report.turns
    );
    Ok(())
}

pub(crate) fn tools_of(word: &str) -> Result<ToolsMode> {
    Ok(match word {
        "s2" => ToolsMode::S2,
        "sig" => ToolsMode::Sig,
        "compact" => ToolsMode::Compact,
        "full" => ToolsMode::Full,
        other => bail!("--tools takes s2, sig, compact or full, not {other}"),
    })
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
