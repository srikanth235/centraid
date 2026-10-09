//! THE MODEL, AS THE PLANE SEES IT: text in, text out.
//!
//! An engine (llama.cpp over a GGUF file) implements [`Model`] and nothing else
//! in this crate knows an engine exists. The plane hands it a finished prompt,
//! a token ceiling and stop strings (and an optional GBNF grammar, which no turn
//! sends today: the native plane's model writes text the runtime reads), and takes
//! text back — streaming each piece to a callback as it is produced.
//!
//! # WHAT AN ENGINE MUST DO
//!
//! * **Obey a grammar when one is sent.** It is a constraint, not a hint.
//! * **Decode greedily** (`temperature == 0.0`). The same prompt must give the
//!   same call, or a run measures noise.
//! * **Poll [`Cancel`] inside prefill as well as between tokens.** Reading a
//!   1.5K-token prompt on a phone takes seconds, and "Stop" must not wait for
//!   the first token to be heard.
//! * **Not retain the prompt or the output.** Both hold the member's data.
//! * **Report [`Finish::Cancelled`] and return the text so far**, not an error.
//!
//! # IMAGES
//!
//! A request may carry decoded images ([`ImageInput`]), and the prompt says
//! where each one goes with [`MEDIA_MARKER`], in order. The engine encodes an
//! image where its marker stands, as part of prefill: **an image encode is
//! prefill**, so a Stop is polled before and after it. An engine that reads no
//! images says so ([`Model::has_vision`]) and the plane never asks it to.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// A cancellation token, shared between whoever asks and whoever generates.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask the running generation to stop at its next check.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// Clear the flag, for the next turn on the same session.
    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// What the streaming callback tells the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Continue,
    /// Stop now. Not a failure: the caller has what it wanted.
    Stop,
}

/// Where an image goes in a prompt: llama.cpp's own media marker, so the plane
/// and the engine agree on one string. A prompt holds exactly one per image in
/// [`GenerateRequest::images`], and the plane strips this string out of
/// everything a member or a document wrote.
pub const MEDIA_MARKER: &str = "<__media__>";

/// One image the model reads: decoded 8-bit RGB, already scaled by the plane's
/// owner to a size the context can afford ([`crate::attach::IMAGE_MAX_EDGE`]).
#[derive(Clone, Copy)]
pub struct ImageInput<'a> {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` bytes, row-major, `RGBRGB…`.
    pub rgb: &'a [u8],
}

impl std::fmt::Debug for ImageInput<'_> {
    /// Never the pixels: they are the member's photograph.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageInput")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish_non_exhaustive()
    }
}

/// One generation's inputs.
#[derive(Debug, Clone, Copy)]
pub struct GenerateRequest<'a> {
    /// The finished prompt, special tokens included, ending where the model
    /// should begin (`<|im_start|>assistant\n<think>\n\n</think>\n\n`, see
    /// [`crate::prompt::ASSISTANT_TURN`]).
    pub prompt: &'a str,
    /// A GBNF grammar the output must satisfy, or `None` for free text.
    pub grammar: Option<&'a str>,
    /// The most tokens to produce.
    pub max_tokens: u32,
    /// Strings that end the generation. They are not part of the output.
    pub stop: &'a [&'a str],
    /// `0.0` is greedy decoding, which is all the plane asks for.
    pub temperature: f32,
    /// Checked during prefill and between tokens.
    pub cancel: &'a Cancel,
    /// The images [`MEDIA_MARKER`]s in the prompt stand for, in order. Empty
    /// for every generation but an attachment's.
    pub images: &'a [ImageInput<'a>],
}

/// Why a generation ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    /// A stop string, the end-of-turn token, or the grammar's end.
    Stop,
    /// `max_tokens` was reached.
    Length,
    /// [`Cancel`] was set, or the callback said [`Control::Stop`].
    Cancelled,
}

/// A finished generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generation {
    /// Everything produced, stop strings excluded.
    pub text: String,
    pub finish: Finish,
    pub prompt_tokens: u32,
    pub generated_tokens: u32,
}

/// An engine failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModelError {
    /// The file would not load: missing, truncated, or not a model this engine
    /// reads.
    #[error("the model would not load: {0}")]
    Load(String),
    /// The engine failed mid-generation.
    #[error("the model failed: {0}")]
    Generate(String),
    /// The prompt does not fit the engine's context window. The plane budgets
    /// below this; reaching it means the budget and the engine disagree.
    #[error("the prompt needs {needed} tokens and the engine holds {held}")]
    ContextExceeded { needed: u32, held: u32 },
    /// The request carries an image and this engine has no projector loaded.
    #[error("this model has no vision projector loaded")]
    NoVision,
}

/// A loaded model.
///
/// `Send + Sync` because one model serves every vault handle in the process
/// and a turn runs on whichever thread the shell's core call arrived on. An
/// engine that is not re-entrant serialises inside `generate`.
pub trait Model: Send + Sync {
    /// Whether a vision projector is loaded, so a request may carry images.
    fn has_vision(&self) -> bool {
        false
    }

    /// Load the vision projector at `projector` alongside the text weights.
    /// Idempotent for the same file; the text weights stay loaded.
    ///
    /// # Errors
    /// [`ModelError::Load`] when the file is missing, is not a projector for
    /// this model, or the engine reads no images.
    fn attach_vision(&self, _projector: &std::path::Path) -> Result<(), ModelError> {
        Err(ModelError::Load("this engine reads no images".to_owned()))
    }

    /// Generate, calling `on_token` with each piece as it is produced.
    ///
    /// # Errors
    /// [`ModelError`] when the engine fails. A cancelled generation is
    /// `Ok` with [`Finish::Cancelled`].
    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError>;
}
