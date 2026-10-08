//! THE ON-DEVICE CHAT ENGINE: llama.cpp behind `centraid-assist`'s traits.
//!
//! [`centraid_assist`] is the plane — registry, prompt, grammar, turn loop — and
//! knows no engine. This crate is the one engine: it implements
//! [`centraid_assist::Model`] and [`centraid_assist::ModelLoader`] over
//! llama.cpp, and nothing else in the workspace depends on llama.cpp.
//!
//! | Module | What it owns | Built |
//! |---|---|---|
//! | [`generate`] | The generation loop — cancel polling, chunked prefill, images as prefill, stop strings, UTF-8 — over a [`generate::Backend`] a test can fake. | always |
//! | `engine` | llama.cpp as that backend: weights, an optional vision projector (`mtmd`), a fresh context per generation, the grammar + greedy sampler chain. | `engine` feature |
//!
//! # THE `engine` FEATURE: LLAMA.CPP BUILDS WHERE THE PHONE'S CORE IS BUILT
//!
//! `llama-cpp-2` is an optional dependency and `engine` turns it on; so does
//! `centraid-core-ffi`'s `llama`, which is how the phone's library carries it
//! (R-CHAT-10 in `docs/decisions.md`). The llama.cpp build is a `cmake`
//! compile that costs ~5 minutes cold, and a workspace build that did it for
//! every pull request overran the PR gate's cold budget. So a plain
//! `cargo build --workspace` compiles this crate **without** llama.cpp:
//! [`generate`] and [`Config`] — the generation loop and everything it is
//! tested with — are built, linted and tested by the gate, and what `engine`
//! adds (`engine`, [`LlamaLoader`], [`LlamaModel`], `process_host`, the
//! `assist-eval-llama` binary and the two real-model suites) is built, linted
//! and tested by the `engine` job in `.github/workflows/gate.yml`, with
//! `--features engine` (or `centraid-core-ffi/llama`, which implies it).
//!
//! # ONE HOST PER PROCESS
//!
//! A phone holds several vault handles and one model, so the slot is
//! `process_host`: one [`ModelHost`] with this engine's loader registered,
//! which `centraid_open` hands to every handle it opens. A shell never sees the
//! engine — it asks the core's `AssistRequest` for the model's status, loads it
//! and sends.
//!
//! # WHY `llama-cpp-2`
//!
//! It is the maintained Rust binding (utilityai) that vendors llama.cpp's source
//! and builds it with the `cmake` crate for every target this product ships:
//! macOS and iOS with Metal, Android with the NDK, Linux. It exposes exactly
//! the surface the [`centraid_assist::Model`] contract needs — a context, a
//! batch, the grammar sampler — and the pinned version is a Qwen3.5-capable
//! llama.cpp. The alternative was a hand-written `bindgen` layer over a
//! submodule, which is the same cmake build plus a binding to keep in step
//! with an API llama.cpp changes weekly.
//!
//! # BUILD REQUIREMENT
//!
//! With `engine`: `cmake` on `PATH` and a C++17 toolchain (Xcode's, or the
//! Android NDK's): see `docs/toolchain.md`. Without it, nothing beyond Rust.

#[cfg(feature = "engine")]
pub mod engine;
pub mod generate;

#[cfg(feature = "engine")]
use std::sync::{Arc, OnceLock};

#[cfg(feature = "engine")]
use centraid_assist::ModelHost;

#[cfg(feature = "engine")]
pub use engine::{LlamaLoader, LlamaModel};

/// Built for the iOS Simulator (`aarch64-apple-ios-sim`, or the Intel
/// `x86_64-apple-ios`, which only ever ran there).
pub const ON_SIMULATOR: bool = cfg!(all(
    target_os = "ios",
    any(target_abi = "sim", target_arch = "x86_64")
));

/// What the engine is told about the machine it runs on.
#[derive(Debug, Clone)]
pub struct Config {
    /// The context window, in tokens: prompt and answer together. The plane's
    /// budget is 4096 (`centraid_assist::prompt::Budget::DEFAULT.context`): the
    /// first half is what routing and phrasing plan inside, the rest is room
    /// for a turn with an attachment.
    pub context: u32,
    /// How many prompt tokens one prefill call evaluates. Cancel is polled
    /// between chunks, so this is the longest a Stop waits.
    pub chunk: u32,
    /// Layers to offload to the GPU: all of them on an Apple device or Mac
    /// (Metal), none elsewhere — **and none on the iOS Simulator**, whose GPU
    /// is a software stand-in that llama.cpp accepts and then computes wrongly
    /// (measured: every route the same tool, 9 minutes for the 65-case eval the
    /// Mac's Metal does in 20 seconds). At zero the context also keeps its
    /// KV cache and its prefill operators on the CPU: ggml otherwise hands any
    /// large matrix product to the GPU backend whatever the layer count.
    pub gpu_layers: u32,
    /// CPU threads, or `None` for up to four of the cores there are.
    pub threads: Option<i32>,
    /// Let llama.cpp write its own log to stderr. Off in a shell; on for
    /// `assist-eval-llama`, where a grammar it refuses is the finding.
    pub logs: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            context: 4096,
            chunk: 128,
            gpu_layers: if cfg!(target_vendor = "apple") && !ON_SIMULATOR {
                999
            } else {
                0
            },
            threads: None,
            logs: false,
        }
    }
}

impl Config {
    /// The CPU threads a generation uses: [`Config::threads`] when set, else up
    /// to four of the cores there are. Public so it is built, linted and
    /// tested without `engine`, which is its only caller.
    #[must_use]
    pub fn threads(&self) -> i32 {
        self.threads.unwrap_or_else(|| {
            let cores = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
            i32::try_from(cores.min(4)).unwrap_or(4)
        })
    }
}

/// The process's one model slot, with this engine's loader registered.
///
/// Registered exactly once, however many handles ask: the first call builds the
/// host and every later call returns the same one.
#[cfg(feature = "engine")]
#[must_use]
pub fn process_host() -> Arc<ModelHost> {
    static HOST: OnceLock<Arc<ModelHost>> = OnceLock::new();
    Arc::clone(HOST.get_or_init(|| {
        let host = ModelHost::new();
        host.set_loader(Arc::new(LlamaLoader::default()));
        Arc::new(host)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "engine")]
    #[test]
    fn the_process_host_is_one_host_and_it_has_an_engine() {
        use centraid_assist::ModelState;

        assert!(Arc::ptr_eq(&process_host(), &process_host()));
        let dir =
            std::env::temp_dir().join(format!("centraid-assist-llama-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("model.gguf");
        std::fs::write(&file, b"bytes").unwrap();
        // A file that is there is PRESENT — an engine could read it — and not
        // NO_ENGINE, which is what a host with no loader says.
        assert_eq!(process_host().status(&file).state, ModelState::Present);
        assert_eq!(
            process_host().status(&dir.join("nowhere.gguf")).state,
            ModelState::Absent
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_defaults_match_the_plane_budget_and_the_platform() {
        let config = Config::default();
        assert_eq!(
            config.context,
            centraid_assist::prompt::Budget::DEFAULT.context
        );
        assert!(config.chunk > 0 && config.chunk <= config.context);
        assert!((1..=4).contains(&config.threads()));
        assert_eq!(
            config.gpu_layers > 0,
            cfg!(target_vendor = "apple") && !ON_SIMULATOR
        );
    }
}
