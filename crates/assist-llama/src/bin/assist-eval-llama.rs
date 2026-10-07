//! `assist-eval-llama` — `assist-eval` with llama.cpp linked, so `--model` scores
//! a GGUF file.
//!
//! ```text
//! cargo run --release -p centraid-assist-llama --bin assist-eval-llama -- \
//!     --model ~/.cache/centraid/models/Qwen3.5-0.8B-Q4_0.gguf [--verbose]
//! ```
//!
//! `ASSIST_EVAL_GPU_LAYERS=0` forces the CPU, for comparing it with Metal.

use std::process::ExitCode;

use centraid_assist_llama::{Config, LlamaLoader};

fn main() -> ExitCode {
    let mut config = Config {
        logs: true,
        ..Config::default()
    };
    if let Some(layers) = std::env::var("ASSIST_EVAL_GPU_LAYERS")
        .ok()
        .and_then(|value| value.parse().ok())
    {
        config.gpu_layers = layers;
    }
    centraid_assist::cli::main(Some(&LlamaLoader::new(config)))
}
