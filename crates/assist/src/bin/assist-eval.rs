//! `assist-eval` — the routing eval harness. The body is
//! [`centraid_assist::cli`]; this binary links no engine, so `--model` points at
//! `assist-eval-llama`, which is the same command line with llama.cpp linked.

use std::process::ExitCode;

fn main() -> ExitCode {
    centraid_assist::cli::main(None)
}
