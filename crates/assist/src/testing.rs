//! DETERMINISTIC STAND-INS for the engine.
//!
//! Public because three crates test through them: this one, `crates/core` (the
//! proto surface over a real vault) and `crates/core-ffi`. None of them is a
//! model: [`ScriptedModel`] says what it was scripted to say, which is exactly
//! what makes a run through the plane a test of the *plane* — the steps, the
//! cards, the words — and not of any weights.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::mpsc::Sender;

use crate::model::{Cancel, Control, Finish, GenerateRequest, Generation, Model, ModelError};

/// What a fake saw of one `generate`.
#[derive(Debug, Clone, PartialEq)]
pub struct SeenRequest {
    pub prompt: String,
    pub grammar: Option<String>,
    pub max_tokens: u32,
    pub stop: Vec<String>,
    pub temperature: f32,
    /// `(width, height)` of each image the request carried.
    pub images: Vec<(u32, u32)>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Streams `text` to the callback three characters at a time, honouring both
/// cancellation paths the way an engine must. `fire_after` sets the request's
/// cancel token after that many pieces, to simulate a Stop tap mid-stream.
fn stream(
    text: &str,
    request: &GenerateRequest<'_>,
    on_token: &mut dyn FnMut(&str) -> Control,
    fire_after: Option<usize>,
) -> Generation {
    let characters: Vec<char> = text.chars().collect();
    let mut produced = String::new();
    let mut pieces = 0u32;
    for chunk in characters.chunks(3) {
        if fire_after.is_some_and(|after| pieces as usize >= after) {
            request.cancel.cancel();
        }
        if request.cancel.is_cancelled() {
            return finished(produced, Finish::Cancelled, pieces);
        }
        let piece: String = chunk.iter().collect();
        produced.push_str(&piece);
        pieces += 1;
        if on_token(&piece) == Control::Stop {
            return finished(produced, Finish::Cancelled, pieces);
        }
    }
    if request.cancel.is_cancelled() {
        return finished(produced, Finish::Cancelled, pieces);
    }
    finished(produced, Finish::Stop, pieces)
}

fn finished(text: String, finish: Finish, generated: u32) -> Generation {
    Generation {
        text,
        finish,
        prompt_tokens: 0,
        generated_tokens: generated,
    }
}

fn see(request: &GenerateRequest<'_>) -> SeenRequest {
    SeenRequest {
        prompt: request.prompt.to_owned(),
        grammar: request.grammar.map(str::to_owned),
        max_tokens: request.max_tokens,
        stop: request.stop.iter().map(|stop| (*stop).to_owned()).collect(),
        temperature: request.temperature,
        images: request
            .images
            .iter()
            .map(|image| (image.width, image.height))
            .collect(),
    }
}

/// A model that says what it was scripted to say, one output per `generate`,
/// and records what it was asked. An exhausted script is an engine failure.
#[derive(Default)]
pub struct ScriptedModel {
    script: Mutex<VecDeque<String>>,
    seen: Mutex<Vec<SeenRequest>>,
    fire: Mutex<Option<(usize, usize)>>,
    vision: std::sync::atomic::AtomicBool,
}

impl ScriptedModel {
    /// A model whose script is already spent: its first `generate` fails.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn new<S: Into<String>>(outputs: impl IntoIterator<Item = S>) -> Self {
        Self {
            script: Mutex::new(outputs.into_iter().map(Into::into).collect()),
            ..Self::default()
        }
    }

    /// A model with a vision projector loaded, which a request may carry
    /// images to.
    #[must_use]
    pub fn seeing(self) -> Self {
        self.vision.store(true, std::sync::atomic::Ordering::SeqCst);
        self
    }

    /// While generating output number `index` (from 0), fire the cancel token
    /// once `after_pieces` pieces have streamed.
    #[must_use]
    pub fn cancelling_during(self, index: usize, after_pieces: usize) -> Self {
        *lock(&self.fire) = Some((index, after_pieces));
        self
    }

    /// Every prompt asked, in order.
    #[must_use]
    pub fn prompts(&self) -> Vec<String> {
        lock(&self.seen)
            .iter()
            .map(|seen| seen.prompt.clone())
            .collect()
    }

    /// Every request, in order.
    #[must_use]
    pub fn requests(&self) -> Vec<SeenRequest> {
        lock(&self.seen).clone()
    }
}

impl Model for ScriptedModel {
    fn has_vision(&self) -> bool {
        self.vision.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn attach_vision(&self, _: &std::path::Path) -> Result<(), ModelError> {
        self.vision.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        let index = {
            let mut seen = lock(&self.seen);
            seen.push(see(request));
            seen.len() - 1
        };
        let output = lock(&self.script)
            .pop_front()
            .ok_or_else(|| ModelError::Generate("the script has no more outputs".to_owned()))?;
        let fire_after = (*lock(&self.fire))
            .filter(|(at, _)| *at == index)
            .map(|(_, after)| after);
        Ok(stream(&output, request, on_token, fire_after))
    }
}

/// A model that streams one piece, tells the test it has started, then waits —
/// until it is cancelled. For proving that Stop reaches a running generation.
pub struct StallingModel {
    started: Mutex<Sender<()>>,
}

impl StallingModel {
    #[must_use]
    pub fn new(started: Sender<()>) -> Self {
        Self {
            started: Mutex::new(started),
        }
    }
}

impl Model for StallingModel {
    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        let _ = on_token("{");
        let _ = lock(&self.started).send(());
        let cancel: &Cancel = request.cancel;
        while !cancel.is_cancelled() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Ok(finished("{".to_owned(), Finish::Cancelled, 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request<'a>(prompt: &'a str, cancel: &'a Cancel) -> GenerateRequest<'a> {
        GenerateRequest {
            prompt,
            grammar: None,
            max_tokens: 8,
            stop: &[],
            temperature: 0.0,
            cancel,
            images: &[],
        }
    }

    #[test]
    fn a_script_streams_three_characters_at_a_time_and_is_recorded() {
        let model = ScriptedModel::new(["abcdefg"]);
        let cancel = Cancel::new();
        let mut pieces = Vec::new();
        let generation = model
            .generate(&request("p", &cancel), &mut |piece| {
                pieces.push(piece.to_owned());
                Control::Continue
            })
            .unwrap();
        assert_eq!(pieces, ["abc", "def", "g"]);
        assert_eq!(generation.text, "abcdefg");
        assert_eq!(generation.finish, Finish::Stop);
        assert_eq!(model.prompts(), ["p"]);
    }

    #[test]
    fn a_callback_stop_and_a_cancelled_token_both_end_the_stream_cancelled() {
        let model = ScriptedModel::new(["abcdefghi", "abcdefghi"]);
        let cancel = Cancel::new();
        let by_callback = model
            .generate(&request("p", &cancel), &mut |_| Control::Stop)
            .unwrap();
        assert_eq!(
            (by_callback.text.as_str(), by_callback.finish),
            ("abc", Finish::Cancelled)
        );
        cancel.cancel();
        let by_token = model
            .generate(&request("p", &cancel), &mut |_| Control::Continue)
            .unwrap();
        assert_eq!(
            (by_token.text.as_str(), by_token.finish),
            ("", Finish::Cancelled)
        );
    }
}
