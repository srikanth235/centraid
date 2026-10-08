//! `assist-step` — the phone's decode step, one GGUF loaded once, over stdin and stdout.
//!
//! ```text
//! cargo build --release -p centraid-assist-llama --features engine --bin assist-step
//! ASSIST_STEP_THREADS=4 assist-step --model ~/.cache/centraid/models/native-Q4_0.gguf < requests.jsonl
//! ```
//!
//! Each line in is a [`wire::Request`] (a rendered prompt, its `dates:` line, optional limits); each line out is the
//! message `centraid_assist::native::step::decode_step` writes for it, or `{"error": …}`. The call is the phone's
//! (`native_turn::NativeTurn`): `TraceMode::V4`, the phone's `StepOptions` (greedy, think limit 200, 512 tokens)
//! unless the request lowers a limit, and a context of 8192 tokens. So what a Python harness scores through this
//! process IS what the phone decodes, GGUF and engine included; nothing about the step is reimplemented outside
//! `centraid-assist`. One process holds one model (~0.6 GB at Q4_0) and serves one request at a time; a harness that
//! wants parallelism starts more processes.
//!
//! The model is `--model PATH` or `ASSIST_STEP_MODEL`; the threads `--threads N` or `ASSIST_STEP_THREADS`, else every
//! core there is (the phone caps at four; a box that scores a set is not the phone). `ASSIST_STEP_GPU_LAYERS` offloads
//! layers, for comparing a Metal run with the CPU's. llama.cpp's log goes to stderr; stdout carries the protocol and
//! nothing else.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;
use std::time::Instant;

use centraid_assist::host::ModelLoader;
use centraid_assist::model::{Cancel, Control, GenerateRequest, Generation, Model, ModelError};
use centraid_assist::native::step::decode_step;
use centraid_assist::native::think::TraceMode;
use centraid_assist_llama::wire::{self, Request};
use centraid_assist_llama::{Config, LlamaLoader};

/// The phone's context for a step is the eval's: the longest rendered prompt plus a message must fit.
const CONTEXT: u32 = 8192;

/// A model that remembers how many tokens its first generation was given: the step's own prompt, which `StepOutput`
/// does not carry.
struct Counting<'a> {
    inner: &'a dyn Model,
    prompt_tokens: Mutex<Option<u32>>,
}

impl Model for Counting<'_> {
    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        let generation = self.inner.generate(request, on_token)?;
        self.prompt_tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_or_insert(generation.prompt_tokens);
        Ok(generation)
    }
}

fn serve(model: &dyn Model, request: &Request) -> String {
    let counting = Counting {
        inner: model,
        prompt_tokens: Mutex::new(None),
    };
    let start = Instant::now();
    let stepped = decode_step(
        &counting,
        &request.prompt,
        request.dates.as_deref(),
        TraceMode::V4,
        request.options(),
        &Cancel::new(),
    );
    let ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    match stepped {
        Ok(output) => {
            let prompt_tokens = *counting
                .prompt_tokens
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            wire::Reply::of(output, prompt_tokens, ms).line()
        }
        Err(error) => wire::error_line(&error.to_string()),
    }
}

struct Args {
    model: PathBuf,
    threads: i32,
}

fn args() -> Result<Args, String> {
    let mut model = std::env::var_os("ASSIST_STEP_MODEL").map(PathBuf::from);
    let mut threads = std::env::var("ASSIST_STEP_THREADS").ok();
    let mut argv = std::env::args().skip(1);
    while let Some(flag) = argv.next() {
        match flag.as_str() {
            "--model" => model = argv.next().map(PathBuf::from),
            "--threads" => threads = argv.next(),
            other => {
                return Err(format!(
                    "unknown argument {other} (--model PATH, --threads N)"
                ));
            }
        }
    }
    let model = model.ok_or("give the GGUF as --model PATH or ASSIST_STEP_MODEL")?;
    let threads = match threads {
        Some(text) => text
            .parse::<i32>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| format!("threads must be a positive number, not {text:?}"))?,
        None => std::thread::available_parallelism()
            .ok()
            .and_then(|n| i32::try_from(n.get()).ok())
            .unwrap_or(4),
    };
    Ok(Args { model, threads })
}

fn run() -> Result<(), String> {
    let Args {
        model: path,
        threads,
    } = args()?;
    let mut config = Config {
        context: CONTEXT,
        threads: Some(threads),
        logs: true,
        ..Config::default()
    };
    if let Some(layers) = std::env::var("ASSIST_STEP_GPU_LAYERS")
        .ok()
        .and_then(|value| value.parse().ok())
    {
        config.gpu_layers = layers;
    }
    let context = config.context;
    let model = LlamaLoader::new(config)
        .load(&path)
        .map_err(|error| error.to_string())?;

    let mut out = std::io::stdout().lock();
    let mut say = |line: &str| -> Result<(), String> {
        writeln!(out, "{line}")
            .and_then(|()| out.flush())
            .map_err(|error| format!("stdout closed: {error}"))
    };
    say(&wire::ready_line(
        &path.display().to_string(),
        threads,
        context,
    ))?;
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|error| format!("stdin: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match wire::parse_request(&line) {
            Ok(request) => serve(model.as_ref(), &request),
            Err(error) => wire::error_line(&error),
        };
        say(&reply)?;
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // the one failure the protocol cannot answer a request with: the model never loaded, or a pipe closed
            println!("{}", wire::error_line(&error));
            eprintln!("assist-step: {error}");
            ExitCode::FAILURE
        }
    }
}
