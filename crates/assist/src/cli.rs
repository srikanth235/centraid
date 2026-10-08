//! `assist-eval` — the routing eval harness, as a function an engine's binary
//! can call.
//!
//! ```text
//! assist-eval --oracle                    # the fixture against a model that reads it: 100% or the plane is wrong
//! assist-eval --export-jsonl out.jsonl    # prompt + completion pairs for the fine-tune
//! assist-eval --style fine-tuned ...      # the compact prompt (default: stock, the one the phone sends)
//! assist-eval --model path/to/model.gguf  # a real engine (`assist-eval-llama`, in crates/assist-llama)
//! assist-eval --grammar [APP]             # the route GBNF an engine decodes under, the app's tools first
//! ```
//!
//! This crate links no engine, so its own `assist-eval` binary answers
//! `--model` with a pointer; `crates/assist-llama`'s `assist-eval-llama` is the
//! same command line with the llama.cpp loader passed to [`run`]. One parser,
//! one report, two binaries — the engine's dependency stays out of this crate.
//!
//! Routing needs no vault: the prompt a model sees is a function of the
//! question, the scope and the history. The run over a real vault is
//! `crates/core/tests/assist_eval.rs`.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::eval::{EvalFile, export_jsonl, run_routing};
use crate::grammar::route_gbnf;
use crate::host::ModelLoader;
use crate::model::{Control, GenerateRequest, Generation, Model, ModelError};
use crate::prompt::{Budget, PromptStyle, estimate_tokens};
use crate::testing::OracleModel;
use crate::{App, ToolSet};

const USAGE: &str = "usage: assist-eval [--cases FILE] [--verbose] [--style stock|fine-tuned] \
                     (--oracle | --export-jsonl FILE | --model FILE | --grammar [APP])";

fn default_cases() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contracts/assist/eval-cases.json")
}

/// What one `generate` call cost.
#[derive(Debug, Clone, Copy)]
struct Sample {
    prompt_chars: usize,
    estimate: u32,
    prompt_tokens: u32,
    generated: u32,
    first_token: Option<Duration>,
    total: Duration,
}

/// A model that times the one it wraps. `assist-eval` is the only user.
struct Timed<'a> {
    inner: &'a dyn Model,
    samples: Mutex<Vec<Sample>>,
    errors: Mutex<Vec<String>>,
}

impl Model for Timed<'_> {
    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        let start = Instant::now();
        let mut first = None;
        let outcome = self.inner.generate(request, &mut |piece| {
            first.get_or_insert_with(|| start.elapsed());
            on_token(piece)
        });
        match &outcome {
            Ok(generation) => self
                .samples
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(Sample {
                    prompt_chars: request.prompt.chars().count(),
                    estimate: estimate_tokens(request.prompt),
                    prompt_tokens: generation.prompt_tokens,
                    generated: generation.generated_tokens,
                    first_token: first,
                    total: start.elapsed(),
                }),
            Err(error) => self
                .errors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(error.to_string()),
        }
        outcome
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (p * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

/// The measurements a real engine owes this plane: what the real tokenizer
/// says about the prompt budget, and how fast it answered.
fn measurements(samples: &[Sample], budget: Budget) -> String {
    let mut out = String::new();
    let tokens: Vec<u32> = samples.iter().map(|s| s.prompt_tokens).collect();
    let (Some(min), Some(max)) = (tokens.iter().min(), tokens.iter().max()) else {
        return "no generation completed\n".to_owned();
    };
    let mean = tokens.iter().map(|t| f64::from(*t)).sum::<f64>() / tokens.len() as f64;
    let ratios: Vec<f64> = samples
        .iter()
        .map(|s| s.prompt_chars as f64 / f64::from(s.prompt_tokens.max(1)))
        .collect();
    let chars_per_token = ratios.iter().sum::<f64>() / ratios.len() as f64;
    let gaps: Vec<f64> = samples
        .iter()
        .map(|s| f64::from(s.estimate) / f64::from(s.prompt_tokens.max(1)))
        .collect();
    let lowest_gap = gaps.iter().copied().fold(f64::MAX, f64::min);
    let highest_gap = gaps.iter().copied().fold(f64::MIN, f64::max);
    out.push_str(&format!(
        "prompt tokens   real tokenizer min {min} / mean {mean:.0} / max {max}; \
         window {} (route limit {})\n",
        budget.window,
        budget.route_limit()
    ));
    out.push_str(&format!(
        "                {chars_per_token:.2} chars per real token on average; the plane's \
         estimate is {lowest_gap:.2}x to {highest_gap:.2}x the real count (under 1.00x would \
         be an under-count)\n",
    ));
    let mut ttft: Vec<f64> = samples
        .iter()
        .filter_map(|s| s.first_token)
        .map(|d| d.as_secs_f64() * 1000.0)
        .collect();
    ttft.sort_by(f64::total_cmp);
    out.push_str(&format!(
        "time to 1st tok p50 {:.0} ms / p95 {:.0} ms / max {:.0} ms\n",
        percentile(&ttft, 0.5),
        percentile(&ttft, 0.95),
        percentile(&ttft, 1.0)
    ));
    // Decode speed excludes the prefill the first token waited for.
    let mut speeds: Vec<f64> = samples
        .iter()
        .filter(|s| s.generated > 1)
        .filter_map(|s| {
            let decode = s.total.checked_sub(s.first_token?)?.as_secs_f64();
            (decode > 0.0).then(|| f64::from(s.generated - 1) / decode)
        })
        .collect();
    speeds.sort_by(f64::total_cmp);
    out.push_str(&format!(
        "decode          p50 {:.1} tok/s / p5 {:.1} tok/s over {} generations\n",
        percentile(&speeds, 0.5),
        percentile(&speeds, 0.05),
        speeds.len()
    ));
    let wall: f64 = samples.iter().map(|s| s.total.as_secs_f64()).sum();
    let generated: u32 = samples.iter().map(|s| s.generated).sum();
    out.push_str(&format!(
        "generated       {generated} tokens in {wall:.1} s of generation across {} calls \
         (route outputs only)\n",
        samples.len()
    ));
    out
}

/// Run the harness over `args` (the process's, program name excluded).
///
/// `engine` is the loader `--model` opens its file with; `None` is a build
/// that links no engine.
///
/// # Errors
/// A usage or fixture error, as the line to print.
pub fn run(
    args: impl IntoIterator<Item = String>,
    engine: Option<&dyn ModelLoader>,
) -> Result<ExitCode, String> {
    let mut args = args.into_iter().peekable();
    let mut cases = default_cases();
    let mut verbose = false;
    let mut budget = Budget::DEFAULT;
    let mut action: Option<(String, Option<PathBuf>)> = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--cases" => cases = args.next().map(PathBuf::from).ok_or(USAGE)?,
            "--verbose" => verbose = true,
            "--style" => {
                let name = args.next().ok_or(USAGE)?;
                let style = PromptStyle::from_name(&name)
                    .ok_or_else(|| format!("`{name}` is not a prompt style (stock, fine-tuned)"))?;
                budget = budget.styled(style);
            }
            "--oracle" => action = Some((flag, None)),
            "--grammar" => {
                // An optional app id: `--grammar tally` lists Tally's tools first.
                let app = args
                    .next_if(|next| !next.starts_with("--"))
                    .map(PathBuf::from);
                action = Some((flag, app));
            }
            "--export-jsonl" | "--model" => {
                action = Some((flag, Some(args.next().map(PathBuf::from).ok_or(USAGE)?)));
            }
            _ => return Err(USAGE.to_owned()),
        }
    }
    let Some((action, target)) = action else {
        return Err(USAGE.to_owned());
    };
    if action == "--grammar" {
        let scope =
            match target {
                Some(app) => Some(App::from_id(&app.to_string_lossy()).ok_or_else(|| {
                    format!("`{}` is not an app the assistant reads", app.display())
                })?),
                None => None,
            };
        print!("{}", route_gbnf(&ToolSet::for_scope(scope)));
        return Ok(ExitCode::SUCCESS);
    }
    let text = std::fs::read_to_string(&cases).map_err(|e| format!("{}: {e}", cases.display()))?;
    let file = EvalFile::parse(&text).map_err(|e| e.to_string())?;
    match action.as_str() {
        "--export-jsonl" => {
            let out = target.ok_or(USAGE)?;
            let jsonl = export_jsonl(&file, budget).map_err(|e| e.to_string())?;
            std::fs::write(&out, jsonl).map_err(|e| format!("{}: {e}", out.display()))?;
            eprintln!("wrote {} cases to {}", file.cases.len(), out.display());
            Ok(ExitCode::SUCCESS)
        }
        "--oracle" => {
            let oracle = OracleModel::new(file.oracle_routes().map_err(|e| e.to_string())?);
            let report = run_routing(&oracle, &file, budget).map_err(|e| e.to_string())?;
            print!("{report}");
            Ok(if report.exact() == report.total() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            })
        }
        _ => {
            let loader = engine.ok_or_else(|| {
                "this binary links no engine; the same command line with llama.cpp is \
                 `cargo run --release -p centraid-assist-llama --features engine --bin assist-eval-llama -- --model FILE`"
                    .to_owned()
            })?;
            let path = target.ok_or(USAGE)?;
            let started = Instant::now();
            let model = loader.load(&path).map_err(|e| e.to_string())?;
            println!(
                "load            {:.2} s ({})",
                started.elapsed().as_secs_f64(),
                path.display()
            );
            let timed = Timed {
                inner: model.as_ref(),
                samples: Mutex::new(Vec::new()),
                errors: Mutex::new(Vec::new()),
            };
            let report = run_routing(&timed, &file, budget).map_err(|e| e.to_string())?;
            print!("{report}");
            if verbose {
                for case in &report.cases {
                    println!("  case {:<28} {}", case.id, case.output);
                }
            }
            let samples = timed
                .samples
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            print!("{}", measurements(&samples, budget));
            let errors = timed
                .errors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for error in errors.iter() {
                println!("engine error    {error}");
            }
            Ok(if report.exact() == report.total() && errors.is_empty() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            })
        }
    }
}

/// The binary's `main`: [`run`] over the process's arguments, errors to stderr
/// with exit code 2.
#[must_use]
pub fn main(engine: Option<&dyn ModelLoader>) -> ExitCode {
    match run(std::env::args().skip(1), engine) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}
