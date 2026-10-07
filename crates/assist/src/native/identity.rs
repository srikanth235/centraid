//! THE MODEL'S IDENTITY: which tokenizer the fine-tuned model reads, and the
//! special strings of its chat and tool-call format, named once.
//!
//! The runtime's prompt (`prompt.rs`), its call reader (`parse.rs`) and the
//! transcript renderer (`transcript.rs`) spell these tokens from [`MODEL`];
//! `nativetools export` writes the same struct as `identity.json`, and
//! `experiments/toolchat/native/render.py` reads that file for the constants
//! it still names (the tokenizer id, the markers its tokenizer code looks for)
//! instead of carrying its own literals, so the renderer that makes the
//! training text and the prompt the runtime makes cannot name different
//! tokens. The layout around the markers (a role name and a newline after
//! `im_start`, a blank line between `think_close` and the call) is written
//! once, in `transcript.rs`, which `render.py`'s self-test checks against the
//! tokenizer's own chat template.

use serde::Serialize;

/// The model's tokenizer id and the strings its chat format is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ModelIdentity {
    /// The Hugging Face id of the tokenizer (and of the base weights).
    pub tokenizer: &'static str,
    /// Opens a chat message; a role name and a newline follow.
    pub im_start: &'static str,
    /// Closes a chat message, and is the model's stop token.
    pub im_end: &'static str,
    /// Opens the thinking of an assistant message, newline included.
    pub think_open: &'static str,
    /// Closes the thinking.
    pub think_close: &'static str,
    pub tool_call_open: &'static str,
    pub tool_call_close: &'static str,
    /// `<function=` then the tool name and `>`.
    pub function_open: &'static str,
    pub function_close: &'static str,
    /// `<parameter=` then the parameter name and `>`.
    pub parameter_open: &'static str,
    pub parameter_close: &'static str,
    /// Wraps a tool's observation, inside a user turn.
    pub tool_response_open: &'static str,
    pub tool_response_close: &'static str,
    /// Wraps the tool list of the system turn.
    pub tools_open: &'static str,
    pub tools_close: &'static str,
}

/// The one model: Qwen3.5-0.8B fine-tuned on the authored data.
pub const MODEL: ModelIdentity = ModelIdentity {
    tokenizer: "Qwen/Qwen3.5-0.8B",
    im_start: "<|im_start|>",
    im_end: "<|im_end|>",
    think_open: "<think>\n",
    think_close: "</think>",
    tool_call_open: "<tool_call>",
    tool_call_close: "</tool_call>",
    function_open: "<function=",
    function_close: "</function>",
    parameter_open: "<parameter=",
    parameter_close: "</parameter>",
    tool_response_open: "<tool_response>",
    tool_response_close: "</tool_response>",
    tools_open: "<tools>",
    tools_close: "</tools>",
};

/// `identity.json`: the struct as the export writes it.
#[must_use]
pub fn json() -> serde_json::Value {
    serde_json::to_value(MODEL).unwrap_or_default()
}
