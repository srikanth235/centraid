//! llama.cpp, behind [`Backend`].
//!
//! A [`LlamaModel`] is the loaded weights (memory-mapped, offloaded to the GPU
//! on Apple targets) and nothing else. **Each generation gets a fresh
//! context** — KV cache, recurrent state, sampler chain — made after the
//! serialising lock is taken and freed before it is released, which is what
//! makes "retain no prompt and no output" a property of the structure rather
//! than of a reset someone has to remember. Qwen3.5 is a hybrid
//! attention/recurrent model whose state cannot be rewound to a shared prefix
//! the way an attention KV cache can, so there is no prefix to keep that would
//! pay for the risk anyway.
//!
//! # THE PROJECTOR IS THE MODEL'S, AND LOADS LATER
//!
//! A photograph is read by a second file, the vision projector (`mmproj`), which
//! llama.cpp's multimodal library (`mtmd`) holds beside the weights. It is
//! **optional and attached on its own** ([`Model::attach_vision`]): a text chat
//! never loads its 205 MB, and a member who attaches a first photo pays for it
//! then, without the weights being read again. It holds a pointer into the
//! weights, so it is always freed first (declared first; the exit hook clears it
//! before the weights).

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::{Arc, Mutex, Once, OnceLock, PoisonError, Weak};

use centraid_assist::host::ModelLoader;
use centraid_assist::model::{
    Control, GenerateRequest, Generation, ImageInput, MEDIA_MARKER, Model, ModelError,
};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel as Weights;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::mtmd::{
    MtmdBitmap, MtmdContext, MtmdContextParams, MtmdInputChunks, MtmdInputText,
};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::token::data::LlamaTokenData;
use llama_cpp_2::token::data_array::LlamaTokenDataArray;
use llama_cpp_2::{LogOptions, send_logs_to_tracing};

use crate::Config;
use crate::generate::{Backend, run};

/// llama.cpp's backend is initialised once per process and never freed: the
/// weights of every model that is ever loaded borrow it.
fn backend(config: &Config) -> Result<&'static LlamaBackend, ModelError> {
    static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            // BEFORE `init`: the first ggml call builds the device registry
            // and, on Apple targets, compiles the Metal library — and logs
            // about it. Quiet unless asked (`Config::logs`), when llama.cpp
            // keeps its own stderr.
            if !config.logs {
                send_logs_to_tracing(LogOptions::default().with_logs_enabled(false));
            }
            LlamaBackend::init().map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|error| ModelError::Load(format!("llama.cpp would not start: {error}")))
}

/// Every model this process has loaded and not yet dropped, so the exit hook
/// below can free their weights.
static LIVE: Mutex<Vec<Weak<LlamaModel>>> = Mutex::new(Vec::new());

/// FREE EVERY MODEL'S WEIGHTS BEFORE ggml's STATICS ARE.
///
/// ggml's Metal backend asserts, in a static destructor, that no buffer it
/// allocated is still alive. A model held by a `static` — the process's
/// [`ModelHost`](centraid_assist::ModelHost) is one — is alive at `exit()`, so a
/// process that loaded one and then exited normally ended in SIGABRT.
/// `atexit` handlers run in reverse registration order, so one registered
/// **after** the first model has loaded — after ggml has built its device
/// registry and registered that destructor — runs before it. It takes each
/// live model's weights out from under whoever still holds the `Arc`; a
/// generation after that is a typed error, not a crash.
fn free_every_model_at_exit() {
    static REGISTERED: Once = Once::new();
    REGISTERED.call_once(|| {
        extern "C" fn free_models() {
            let live = LIVE.lock().unwrap_or_else(PoisonError::into_inner);
            for model in live.iter().filter_map(Weak::upgrade) {
                // Waits for a generation in flight: its context borrows the
                // weights, and freeing them under it is the crash again. The
                // projector goes first: it points into the weights.
                let mut weights = model.weights.lock().unwrap_or_else(PoisonError::into_inner);
                *model.vision.lock().unwrap_or_else(PoisonError::into_inner) = None;
                *weights = None;
            }
        }
        unsafe extern "C" {
            fn atexit(callback: extern "C" fn()) -> std::ffi::c_int;
        }
        // SAFETY: `atexit` is C's, with this signature on every target this
        // crate builds for, and `free_models` is `extern "C"`, takes nothing and
        // does not unwind (every lock recovers from poison). A failed
        // registration (nonzero) only costs the safety net.
        unsafe { atexit(free_models) };
    });
}

/// Opens GGUF files with llama.cpp. Register it once, on the process's
/// [`centraid_assist::ModelHost`].
#[derive(Debug, Clone, Default)]
pub struct LlamaLoader {
    config: Config,
}

impl LlamaLoader {
    #[must_use]
    pub const fn new(config: Config) -> Self {
        Self { config }
    }
}

impl ModelLoader for LlamaLoader {
    fn load(&self, path: &Path) -> Result<Arc<dyn Model>, ModelError> {
        if !path.is_file() {
            return Err(ModelError::Load(format!(
                "there is no file at {}",
                path.display()
            )));
        }
        let backend = backend(&self.config)?;
        let params = LlamaModelParams::default().with_n_gpu_layers(self.config.gpu_layers);
        let weights = Weights::load_from_file(backend, path, &params).map_err(|error| {
            ModelError::Load(format!("llama.cpp could not read the model: {error}"))
        })?;
        let model = Arc::new(LlamaModel {
            backend,
            vision: Mutex::new(None),
            weights: Mutex::new(Some(weights)),
            config: self.config.clone(),
        });
        {
            let mut live = LIVE.lock().unwrap_or_else(PoisonError::into_inner);
            live.retain(|held| held.strong_count() > 0);
            live.push(Arc::downgrade(&model));
        }
        free_every_model_at_exit();
        Ok(model)
    }
}

/// A loaded model.
pub struct LlamaModel {
    backend: &'static LlamaBackend,
    /// The vision projector, once one is attached. **Declared before
    /// `weights` so it drops first**: it points into them. Locked only while
    /// the weights' lock is held, so there is one lock order.
    vision: Mutex<Option<MtmdContext>>,
    /// The weights, and the lock that makes generations one at a time: a
    /// context is a hundred-megabyte allocation on a phone and the plane's turns
    /// are sequential anyway. `None` once the exit hook has freed them.
    weights: Mutex<Option<Weights>>,
    config: Config,
}

impl LlamaModel {
    /// The model's parameter count, for a log line a shell can show.
    #[must_use]
    pub fn parameters(&self) -> u64 {
        self.weights
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map_or(0, Weights::n_params)
    }
}

impl std::fmt::Debug for LlamaModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlamaModel")
            .field("parameters", &self.parameters())
            .field("config", &self.config)
            .finish()
    }
}

impl Model for LlamaModel {
    fn has_vision(&self) -> bool {
        self.vision
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    fn attach_vision(&self, projector: &Path) -> Result<(), ModelError> {
        if !projector.is_file() {
            return Err(ModelError::Load(format!(
                "there is no projector at {}",
                projector.display()
            )));
        }
        // The weights' lock first (a generation in flight finishes before the
        // projector changes), then the projector's.
        let held = self.weights.lock().unwrap_or_else(PoisonError::into_inner);
        let weights = held.as_ref().ok_or_else(|| {
            ModelError::Load("the model was freed when the process began to exit".to_owned())
        })?;
        let mut slot = self.vision.lock().unwrap_or_else(PoisonError::into_inner);
        let params = MtmdContextParams {
            use_gpu: self.config.gpu_layers > 0,
            print_timings: false,
            n_threads: self.config.threads(),
            ..MtmdContextParams::default()
        };
        let path = projector.to_str().ok_or_else(|| {
            ModelError::Load("the projector path is not valid UTF-8".to_owned())
        })?;
        let context = MtmdContext::init_from_file(path, weights, &params).map_err(|error| {
            ModelError::Load(format!("llama.cpp could not read the projector: {error}"))
        })?;
        if !context.support_vision() {
            return Err(ModelError::Load(
                "that projector does not read images".to_owned(),
            ));
        }
        *slot = Some(context);
        Ok(())
    }

    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        let held = self.weights.lock().unwrap_or_else(PoisonError::into_inner);
        let weights = held.as_ref().ok_or_else(|| {
            ModelError::Generate("the model was freed when the process began to exit".to_owned())
        })?;
        let vision = self.vision.lock().unwrap_or_else(PoisonError::into_inner);
        let mut session = Session::open(self, weights, vision.as_ref(), request)?;
        run(&mut session, request, on_token)
    }
}

fn failed(what: &str, error: impl std::fmt::Display) -> ModelError {
    ModelError::Generate(format!("{what}: {error}"))
}

/// One generation's engine state. Dropped when the generation ends.
struct Session<'m> {
    weights: &'m Weights,
    /// The projector, when one is attached.
    vision: Option<&'m MtmdContext>,
    /// Each image, preprocessed by [`Backend::image_tokens`] and evaluated by
    /// [`Backend::prefill_image`]. Dropped with the session: the pixels are
    /// the member's.
    prepared: Vec<Option<MtmdInputChunks>>,
    context: LlamaContext<'m>,
    batch: LlamaBatch<'m>,
    grammar: Option<LlamaSampler>,
    chunk: usize,
    context_size: u32,
    position: i32,
}

impl<'m> Session<'m> {
    fn open(
        model: &'m LlamaModel,
        weights: &'m Weights,
        vision: Option<&'m MtmdContext>,
        request: &GenerateRequest<'_>,
    ) -> Result<Self, ModelError> {
        if !request.images.is_empty() && vision.is_none() {
            return Err(ModelError::NoVision);
        }
        let config = &model.config;
        let context = weights
            .new_context(
                model.backend,
                LlamaContextParams::default()
                    .with_n_ctx(NonZeroU32::new(config.context))
                    .with_n_batch(config.chunk)
                    .with_n_ubatch(config.chunk)
                    .with_n_threads(config.threads())
                    .with_n_threads_batch(config.threads())
                    // A model on the CPU stays there: see `Config::gpu_layers`.
                    .with_offload_kqv(config.gpu_layers > 0)
                    .with_op_offload(config.gpu_layers > 0),
            )
            .map_err(|error| failed("the context would not open", error))?;
        let grammar = request
            .grammar
            .map(|grammar| LlamaSampler::grammar(weights, grammar, "root"))
            .transpose()
            .map_err(|error| failed("the grammar was refused", error))?;
        let chunk = config.chunk as usize;
        Ok(Self {
            weights,
            vision,
            prepared: request.images.iter().map(|_| None).collect(),
            context_size: context.n_ctx(),
            context,
            batch: LlamaBatch::new(chunk.max(1), 1),
            grammar,
            chunk,
            position: 0,
        })
    }
}

impl Backend for Session<'_> {
    type Token = LlamaToken;

    fn tokenize(&self, text: &str) -> Result<Vec<LlamaToken>, ModelError> {
        // `parse_special`: the prompt carries `<|im_start|>` and friends as
        // text, and they must become the control tokens the model was trained
        // on. `add_special` is off: the template owns every special token.
        Ok(self.weights.vocab().tokenize(text.as_bytes(), false, true))
    }

    fn context_size(&self) -> u32 {
        self.context_size
    }

    fn chunk(&self) -> usize {
        self.chunk
    }

    fn image_tokens(&mut self, index: usize, image: &ImageInput<'_>) -> Result<u32, ModelError> {
        let vision = self.vision.ok_or(ModelError::NoVision)?;
        let bitmap = MtmdBitmap::from_image_data(image.width, image.height, image.rgb)
            .map_err(|error| failed("the image would not load", error))?;
        // The marker alone: mtmd wraps the image in its own begin and end
        // tokens, so the chunks are exactly what this image costs.
        let chunks = vision
            .tokenize(
                MtmdInputText {
                    text: MEDIA_MARKER.to_owned(),
                    add_special: false,
                    parse_special: true,
                },
                &[&bitmap],
            )
            .map_err(|error| failed("the image would not preprocess", error))?;
        let tokens = u32::try_from(chunks.total_tokens()).unwrap_or(u32::MAX);
        self.prepared[index] = Some(chunks);
        Ok(tokens)
    }

    fn prefill_image(&mut self, index: usize, _: &ImageInput<'_>) -> Result<(), ModelError> {
        let vision = self.vision.ok_or(ModelError::NoVision)?;
        let chunks = self.prepared[index]
            .take()
            .ok_or_else(|| ModelError::Generate("the image was not prepared".to_owned()))?;
        // ONE CALL ENCODES AND EVALUATES: the projector's encoder is a single
        // graph run, and the embeddings are then decoded in `chunk`-sized
        // batches. Neither is interruptible; `run` polls cancel on both sides.
        let batch = i32::try_from(self.chunk).unwrap_or(i32::MAX);
        self.position = chunks
            .eval_chunks(vision, &self.context, self.position, 0, batch, false)
            .map_err(|error| failed("the image would not encode", error))?;
        Ok(())
    }

    fn prefill(&mut self, tokens: &[LlamaToken], last: bool) -> Result<(), ModelError> {
        self.batch.clear();
        for (index, token) in tokens.iter().enumerate() {
            let wants_logits = last && index + 1 == tokens.len();
            self.batch
                .add(*token, self.position, &[0], wants_logits)
                .map_err(|error| failed("the prompt would not batch", error))?;
            self.position += 1;
        }
        self.context
            .decode(&mut self.batch)
            .map_err(|error| failed("the prompt would not decode", error))
    }

    /// Greedy under the grammar — and cheap, which a sampler chain is not.
    ///
    /// A grammar sampler in a chain is applied to the whole vocabulary on every
    /// step, and Qwen3.5's is 248K tokens: the grammar's walk over all of them
    /// costs more than the model's forward pass for a 0.8B model. llama.cpp's
    /// own `common_sampler` avoids it by choosing first and asking the grammar
    /// second, and so does this: take the unconstrained best token, ask the
    /// grammar about **that one token**, and only when it refuses constrain the
    /// whole distribution and choose again. The two orders pick the same
    /// token — the best of the allowed set is the best overall when the best
    /// overall is allowed — so this is an optimisation and not a different
    /// sampler.
    fn sample(&mut self) -> Result<LlamaToken, ModelError> {
        let logits = self.context.get_logits();
        let (best, score) = best_of(logits);
        let Some(grammar) = self.grammar.as_mut() else {
            return Ok(best);
        };
        let mut one = LlamaTokenDataArray::new(vec![LlamaTokenData::new(best, score, 0.0)], false);
        grammar.apply(&mut one);
        let allowed = |logit: f32| !(logit.is_infinite() && logit < 0.0);
        let token = if one.data.first().is_some_and(|data| allowed(data.logit())) {
            best
        } else {
            let mut all = self.context.token_data_array();
            grammar.apply(&mut all);
            all.data
                .iter()
                .filter(|data| allowed(data.logit()))
                .max_by(|a, b| a.logit().total_cmp(&b.logit()))
                .map(LlamaTokenData::id)
                .ok_or_else(|| {
                    ModelError::Generate("the grammar allows no token here".to_owned())
                })?
        };
        // Accepting is what advances the grammar. The end-of-turn token is not
        // fed to it: it was allowed because the grammar is complete, and there
        // is nothing after it to constrain.
        if !self.weights.vocab().is_eog(token) {
            grammar.accept(token);
        }
        Ok(token)
    }

    fn advance(&mut self, token: LlamaToken) -> Result<(), ModelError> {
        self.batch.clear();
        self.batch
            .add(token, self.position, &[0], true)
            .map_err(|error| failed("a token would not batch", error))?;
        self.position += 1;
        self.context
            .decode(&mut self.batch)
            .map_err(|error| failed("a token would not decode", error))
    }

    fn is_end(&self, token: LlamaToken) -> bool {
        self.weights.vocab().is_eog(token)
    }

    fn piece(&self, token: LlamaToken, into: &mut Vec<u8>) {
        // Control tokens render as nothing: the only one a grammar-bound model
        // can produce is the end of turn, which `is_end` already caught.
        self.weights
            .vocab()
            .token_to_piece_into(token, into, false, None);
    }
}

/// The highest-scoring token and its logit. The first of equals wins, as in
/// llama.cpp's own greedy sampler.
fn best_of(logits: &[f32]) -> (LlamaToken, f32) {
    let mut best = (0usize, f32::NEG_INFINITY);
    for (index, logit) in logits.iter().enumerate() {
        if *logit > best.1 {
            best = (index, *logit);
        }
    }
    (
        LlamaToken::new(i32::try_from(best.0).unwrap_or(i32::MAX)),
        best.1,
    )
}
