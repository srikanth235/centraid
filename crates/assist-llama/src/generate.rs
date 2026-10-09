//! THE GENERATION LOOP, WITHOUT AN ENGINE IN IT.
//!
//! Everything [`centraid_assist::Model`] promises that is not llama.cpp's to
//! keep is kept here, over a [`Backend`] a test can fake:
//!
//! * [`Cancel`] is polled **before every prefill chunk** (a phone reads a 1.5K
//!   prompt for seconds, and a chunk is the unit llama.cpp cannot be
//!   interrupted inside) and **before every token**;
//! * the streaming callback's [`Control::Stop`] is a cancel, not an error;
//! * stop strings end the text and are not in it, and a stop string that
//!   arrives split across tokens is still caught — the loop holds back the
//!   tail of the text that could still become one rather than streaming it;
//! * a token's bytes are streamed only as whole UTF-8 characters (a byte-level
//!   BPE splits `é` and an emoji across tokens);
//! * the prompt is never longer than the context, and the answer is clamped to
//!   what is left, so a long prompt ends in `Finish::Length` rather than in an
//!   engine failure mid-decode;
//! * **an image is prefill**: the prompt is split at each
//!   [`MEDIA_MARKER`](centraid_assist::model::MEDIA_MARKER), text goes through
//!   the chunked path above and an image goes to [`Backend::prefill_image`],
//!   with the cancel polled before it and after it. An image encode is one
//!   block the engine cannot be interrupted inside; the plane's 448-pixel cap
//!   is what bounds how long a Stop can wait for it.
//!
//! Nothing here keeps the prompt or the output past the call.

use centraid_assist::model::{
    Control, Finish, GenerateRequest, Generation, ImageInput, MEDIA_MARKER, ModelError,
};

/// What the loop needs of an engine, one generation at a time.
pub trait Backend {
    type Token: Copy;

    /// The prompt as tokens, special tokens parsed.
    fn tokenize(&self, text: &str) -> Result<Vec<Self::Token>, ModelError>;

    /// The context window, in tokens, prompt and answer together.
    fn context_size(&self) -> u32;

    /// How many prompt tokens one prefill call takes.
    fn chunk(&self) -> usize;

    /// How many tokens image `index` takes in the context, once the engine has
    /// preprocessed it. Asked for every image before any prefill, so that a
    /// prompt that cannot fit is refused before a second of work is spent.
    ///
    /// # Errors
    /// [`ModelError::NoVision`] for an engine with no projector.
    fn image_tokens(&mut self, _index: usize, _image: &ImageInput<'_>) -> Result<u32, ModelError> {
        Err(ModelError::NoVision)
    }

    /// Encode image `index` and evaluate it into the context at the current
    /// position. This is prefill, and as long as the encoder takes.
    ///
    /// # Errors
    /// [`ModelError::NoVision`] for an engine with no projector.
    fn prefill_image(&mut self, _index: usize, _image: &ImageInput<'_>) -> Result<(), ModelError> {
        Err(ModelError::NoVision)
    }

    /// Evaluate the next `tokens` of the prompt. `last` is the final chunk: its
    /// final token's logits are what the first answer token is sampled from.
    fn prefill(&mut self, tokens: &[Self::Token], last: bool) -> Result<(), ModelError>;

    /// Choose the next token — grammar and greedy choice applied — and record
    /// it as accepted.
    fn sample(&mut self) -> Result<Self::Token, ModelError>;

    /// Evaluate `token` so the one after it can be sampled.
    fn advance(&mut self, token: Self::Token) -> Result<(), ModelError>;

    /// The end-of-turn (or any end-of-generation) token.
    fn is_end(&self, token: Self::Token) -> bool;

    /// Append `token`'s bytes.
    fn piece(&self, token: Self::Token, into: &mut Vec<u8>);
}

/// The longest prefix of `bytes` that is whole UTF-8 characters. Bytes that are
/// not UTF-8 at all (a lone continuation byte the model should not have
/// produced) are replaced rather than carried forever.
fn take_whole_chars(bytes: &mut Vec<u8>) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => {
            let text = text.to_owned();
            bytes.clear();
            text
        }
        Err(error) => {
            let valid = error.valid_up_to();
            let mut out = String::from_utf8_lossy(&bytes[..valid]).into_owned();
            match error.error_len() {
                // An incomplete character at the end: wait for the next token.
                None => {
                    bytes.drain(..valid);
                }
                // Invalid bytes in the middle: replace them and carry on.
                Some(bad) => {
                    out.push(char::REPLACEMENT_CHARACTER);
                    bytes.drain(..valid + bad);
                    out.push_str(&take_whole_chars(bytes));
                }
            }
            out
        }
    }
}

/// Where in `text` a stop string first begins, searching from `from`.
fn find_stop(text: &str, from: usize, stop: &[&str]) -> Option<usize> {
    let mut from = from.min(text.len());
    while !text.is_char_boundary(from) {
        from -= 1;
    }
    stop.iter()
        .filter(|s| !s.is_empty())
        .filter_map(|s| text[from..].find(s).map(|at| from + at))
        .min()
}

/// How much of the end of `text` could still turn into a stop string, and so
/// must not be streamed yet.
fn held_back(text: &str, stop: &[&str]) -> usize {
    stop.iter()
        .filter(|s| !s.is_empty())
        .map(|s| {
            (1..s.len())
                .rev()
                .filter(|n| s.is_char_boundary(*n))
                .find(|n| text.ends_with(&s[..*n]))
                .unwrap_or(0)
        })
        .max()
        .unwrap_or(0)
}

/// One stretch of a prompt: text the engine tokenizes, or the image at a media
/// marker.
enum Segment<T> {
    Text(Vec<T>),
    Image(usize),
}

/// Run one generation.
///
/// # Errors
/// [`ModelError`] from the backend, or [`ModelError::ContextExceeded`] when the
/// prompt alone fills the window. A cancelled generation is `Ok`.
pub fn run<B: Backend>(
    backend: &mut B,
    request: &GenerateRequest<'_>,
    on_token: &mut dyn FnMut(&str) -> Control,
) -> Result<Generation, ModelError> {
    // The prompt, as text between media markers and the images they stand for.
    let parts: Vec<&str> = request.prompt.split(MEDIA_MARKER).collect();
    if parts.len() - 1 != request.images.len() {
        return Err(ModelError::Generate(format!(
            "the prompt names {} images and the request carries {}",
            parts.len() - 1,
            request.images.len()
        )));
    }
    let mut segments: Vec<Segment<B::Token>> = Vec::new();
    let mut counted = 0u64;
    for (at, part) in parts.iter().enumerate() {
        if at > 0 {
            let index = at - 1;
            counted += u64::from(backend.image_tokens(index, &request.images[index])?);
            segments.push(Segment::Image(index));
        }
        if !part.is_empty() {
            let tokens = backend.tokenize(part)?;
            counted += tokens.len() as u64;
            segments.push(Segment::Text(tokens));
        }
    }
    let held = backend.context_size();
    let prompt_tokens = u32::try_from(counted).unwrap_or(u32::MAX);
    // One slot must stay for the first answer token.
    if prompt_tokens >= held {
        return Err(ModelError::ContextExceeded {
            needed: prompt_tokens.saturating_add(1),
            held,
        });
    }
    let max_tokens = request.max_tokens.min(held - prompt_tokens);
    let finished = |text: String, finish, generated| Generation {
        text,
        finish,
        prompt_tokens,
        generated_tokens: generated,
    };
    // Logits come from the last token of the last chunk, so the prompt must
    // end in text (the template ends at the assistant's turn).
    let Some(last) = segments.len().checked_sub(1) else {
        return Err(ModelError::Generate("the prompt has no tokens".to_owned()));
    };
    if !matches!(segments[last], Segment::Text(_)) {
        return Err(ModelError::Generate(
            "the prompt ends in an image, not in text".to_owned(),
        ));
    }

    let chunk = backend.chunk().max(1);
    for (at, segment) in segments.iter().enumerate() {
        match segment {
            Segment::Text(tokens) => {
                let mut chunks = tokens.chunks(chunk).peekable();
                while let Some(tokens) = chunks.next() {
                    if request.cancel.is_cancelled() {
                        return Ok(finished(String::new(), Finish::Cancelled, 0));
                    }
                    backend.prefill(tokens, at == last && chunks.peek().is_none())?;
                }
            }
            Segment::Image(index) => {
                if request.cancel.is_cancelled() {
                    return Ok(finished(String::new(), Finish::Cancelled, 0));
                }
                backend.prefill_image(*index, &request.images[*index])?;
                if request.cancel.is_cancelled() {
                    return Ok(finished(String::new(), Finish::Cancelled, 0));
                }
            }
        }
    }

    let mut text = String::new();
    let mut streamed = 0usize;
    let mut pending = Vec::new();
    let mut generated = 0u32;
    let finish = loop {
        if request.cancel.is_cancelled() {
            break Finish::Cancelled;
        }
        if generated >= max_tokens {
            break Finish::Length;
        }
        let token = backend.sample()?;
        if backend.is_end(token) {
            break Finish::Stop;
        }
        generated += 1;
        backend.piece(token, &mut pending);
        let from = text.len();
        text.push_str(&take_whole_chars(&mut pending));
        if let Some(at) = find_stop(
            &text,
            from.saturating_sub(longest(request.stop)),
            request.stop,
        ) {
            text.truncate(at);
            if streamed < text.len() && on_token(&text[streamed..]) == Control::Stop {
                return Ok(finished(text, Finish::Cancelled, generated));
            }
            return Ok(finished(text, Finish::Stop, generated));
        }
        let safe = text.len() - held_back(&text, request.stop);
        if safe > streamed {
            let piece = &text[streamed..safe];
            streamed = safe;
            if on_token(piece) == Control::Stop {
                break Finish::Cancelled;
            }
        }
        if generated < max_tokens {
            backend.advance(token)?;
        }
    };
    // What was held back was never a whole stop string: it is output.
    if finish != Finish::Cancelled && streamed < text.len() {
        let _ = on_token(&text[streamed..]);
    }
    Ok(finished(text, finish, generated))
}

fn longest(stop: &[&str]) -> usize {
    stop.iter().map(|s| s.len()).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use centraid_assist::model::Cancel;

    use super::*;

    /// A backend whose "tokens" are bytes of a script. The script is what
    /// `sample` returns, in order; `END` is the end token.
    struct Fake {
        script: Vec<u16>,
        at: usize,
        context: u32,
        chunk: usize,
        prefilled: Vec<usize>,
        decoded: usize,
        cancel_after_prefill_chunks: Option<(usize, Cancel)>,
        cancel_after_samples: Option<(usize, Cancel)>,
        /// What image `n` costs, in context tokens.
        image_cost: u32,
        /// Everything prefilled, in order: `text:<tokens>` and `image:<index>`.
        order: Vec<String>,
        /// The `last` flag of every text prefill.
        lasts: Vec<bool>,
        /// Set the cancel token while an image is being encoded.
        cancel_in_encode: Option<Cancel>,
    }

    const END: u16 = 0xFFFF;

    impl Fake {
        fn saying(text: &str) -> Self {
            let mut script: Vec<u16> = text.bytes().map(u16::from).collect();
            script.push(END);
            Self {
                script,
                at: 0,
                context: 2048,
                chunk: 4,
                prefilled: Vec::new(),
                decoded: 0,
                cancel_after_prefill_chunks: None,
                cancel_after_samples: None,
                image_cost: 50,
                order: Vec::new(),
                lasts: Vec::new(),
                cancel_in_encode: None,
            }
        }
    }

    impl Backend for Fake {
        type Token = u16;

        fn tokenize(&self, text: &str) -> Result<Vec<u16>, ModelError> {
            Ok(text.bytes().map(u16::from).collect())
        }
        fn context_size(&self) -> u32 {
            self.context
        }
        fn chunk(&self) -> usize {
            self.chunk
        }
        fn image_tokens(&mut self, _: usize, _: &ImageInput<'_>) -> Result<u32, ModelError> {
            Ok(self.image_cost)
        }
        fn prefill_image(&mut self, index: usize, _: &ImageInput<'_>) -> Result<(), ModelError> {
            self.order.push(format!("image:{index}"));
            if let Some(cancel) = &self.cancel_in_encode {
                cancel.cancel();
            }
            Ok(())
        }
        fn prefill(&mut self, tokens: &[u16], last: bool) -> Result<(), ModelError> {
            self.order.push(format!("text:{}", tokens.len()));
            self.lasts.push(last);
            self.prefilled.push(tokens.len());
            if let Some((n, cancel)) = &self.cancel_after_prefill_chunks
                && self.prefilled.len() == *n
            {
                cancel.cancel();
            }
            Ok(())
        }
        fn sample(&mut self) -> Result<u16, ModelError> {
            let token = self.script.get(self.at).copied().unwrap_or(END);
            self.at += 1;
            if let Some((n, cancel)) = &self.cancel_after_samples
                && self.at == *n
            {
                cancel.cancel();
            }
            Ok(token)
        }
        fn advance(&mut self, _: u16) -> Result<(), ModelError> {
            self.decoded += 1;
            Ok(())
        }
        fn is_end(&self, token: u16) -> bool {
            token == END
        }
        fn piece(&self, token: u16, into: &mut Vec<u8>) {
            into.push(u8::try_from(token).unwrap());
        }
    }

    fn request<'a>(
        prompt: &'a str,
        stop: &'a [&'a str],
        max_tokens: u32,
        cancel: &'a Cancel,
    ) -> GenerateRequest<'a> {
        GenerateRequest {
            prompt,
            grammar: None,
            max_tokens,
            stop,
            temperature: 0.0,
            cancel,
            images: &[],
        }
    }

    fn collect(fake: &mut Fake, req: &GenerateRequest<'_>) -> (Generation, Vec<String>) {
        let mut pieces = Vec::new();
        let generation = run(fake, req, &mut |piece| {
            pieces.push(piece.to_owned());
            Control::Continue
        })
        .unwrap();
        (generation, pieces)
    }

    #[test]
    fn the_end_token_finishes_and_everything_is_streamed() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying(r#"{"tool":"none"}"#);
        let (generation, pieces) = collect(&mut fake, &request("p", &[], 64, &cancel));
        assert_eq!(generation.text, r#"{"tool":"none"}"#);
        assert_eq!(generation.finish, Finish::Stop);
        assert_eq!(pieces.concat(), generation.text);
        assert_eq!(generation.prompt_tokens, 1);
        assert_eq!(generation.generated_tokens, 15);
    }

    #[test]
    fn the_prompt_is_prefilled_in_chunks_and_the_answer_clamped_to_the_window() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("abcdefghij");
        fake.context = 16;
        let (generation, _) = collect(&mut fake, &request("0123456789", &[], 64, &cancel));
        assert_eq!(fake.prefilled, vec![4, 4, 2]);
        assert_eq!(generation.text, "abcdef", "ten prompt tokens leave six");
        assert_eq!(generation.finish, Finish::Length);
    }

    #[test]
    fn a_prompt_that_fills_the_window_is_a_typed_error() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("x");
        fake.context = 4;
        let error = run(&mut fake, &request("abcd", &[], 8, &cancel), &mut |_| {
            Control::Continue
        })
        .unwrap_err();
        assert_eq!(error, ModelError::ContextExceeded { needed: 5, held: 4 });
    }

    #[test]
    fn max_tokens_is_length_and_does_not_decode_a_token_nobody_will_read() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("abcdef");
        let (generation, _) = collect(&mut fake, &request("p", &[], 3, &cancel));
        assert_eq!(
            (generation.text.as_str(), generation.finish),
            ("abc", Finish::Length)
        );
        assert_eq!(fake.decoded, 2, "the third token is not fed back");
    }

    #[test]
    fn cancel_during_prefill_stops_before_the_next_chunk_with_no_text() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("never said");
        fake.cancel_after_prefill_chunks = Some((1, cancel.clone()));
        let (generation, pieces) = collect(&mut fake, &request("0123456789", &[], 64, &cancel));
        assert_eq!(generation.finish, Finish::Cancelled);
        assert_eq!(generation.text, "");
        assert_eq!(fake.prefilled, vec![4], "the second chunk never ran");
        assert!(pieces.is_empty());
        assert_eq!(fake.at, 0, "and nothing was sampled");
    }

    #[test]
    fn a_cancel_that_is_already_set_does_no_work() {
        let cancel = Cancel::new();
        cancel.cancel();
        let mut fake = Fake::saying("never said");
        let (generation, _) = collect(&mut fake, &request("abc", &[], 64, &cancel));
        assert_eq!(generation.finish, Finish::Cancelled);
        assert!(fake.prefilled.is_empty());
    }

    #[test]
    fn cancel_between_tokens_returns_the_text_so_far_as_ok() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("hello world");
        fake.cancel_after_samples = Some((5, cancel.clone()));
        let (generation, pieces) = collect(&mut fake, &request("p", &[], 64, &cancel));
        assert_eq!(generation.finish, Finish::Cancelled);
        assert_eq!(generation.text, "hello");
        assert_eq!(pieces.concat(), "hello");
        assert_eq!(generation.generated_tokens, 5);
    }

    #[test]
    fn the_callback_saying_stop_is_a_cancel_not_an_error() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("hello world");
        let mut seen = String::new();
        let generation = run(&mut fake, &request("p", &[], 64, &cancel), &mut |piece| {
            seen.push_str(piece);
            if seen.len() >= 3 {
                Control::Stop
            } else {
                Control::Continue
            }
        })
        .unwrap();
        assert_eq!(generation.finish, Finish::Cancelled);
        assert_eq!(generation.text, "hel");
    }

    #[test]
    fn a_stop_string_ends_the_text_and_is_not_in_it_even_when_split_across_tokens() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("one sentence.\nand more");
        let (generation, pieces) = collect(&mut fake, &request("p", &["\n"], 64, &cancel));
        assert_eq!(generation.text, "one sentence.");
        assert_eq!(generation.finish, Finish::Stop);
        assert_eq!(pieces.concat(), "one sentence.");

        // A two-character stop arrives one byte at a time.
        let mut fake = Fake::saying("answer<|im_end|>trailing");
        let (generation, pieces) = collect(&mut fake, &request("p", &["<|im_end|>"], 64, &cancel));
        assert_eq!(generation.text, "answer");
        assert_eq!(
            pieces.concat(),
            "answer",
            "no piece of the stop string was ever streamed"
        );
    }

    #[test]
    fn text_that_only_looks_like_a_stop_string_is_streamed_once_it_stops_looking_like_one() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("a <|im b");
        let (generation, pieces) = collect(&mut fake, &request("p", &["<|im_end|>"], 64, &cancel));
        assert_eq!(generation.text, "a <|im b");
        assert_eq!(pieces.concat(), "a <|im b");
        // And a hold-back that the generation ends inside is flushed.
        let mut fake = Fake::saying("a <|im");
        let (generation, pieces) = collect(&mut fake, &request("p", &["<|im_end|>"], 64, &cancel));
        assert_eq!(generation.text, "a <|im");
        assert_eq!(pieces.concat(), "a <|im");
    }

    #[test]
    fn a_character_split_across_tokens_is_streamed_whole() {
        let cancel = Cancel::new();
        // "é" is 0xC3 0xA9; the fake emits one byte per token.
        let mut fake = Fake::saying("caf\u{e9}!");
        let (generation, pieces) = collect(&mut fake, &request("p", &[], 64, &cancel));
        assert_eq!(generation.text, "caf\u{e9}!");
        assert!(pieces.iter().all(|piece| !piece.contains('\u{fffd}')));
        assert_eq!(pieces.concat(), generation.text);
        assert!(pieces.iter().any(|piece| piece == "\u{e9}"));
    }

    #[test]
    fn invalid_bytes_are_replaced_and_do_not_wedge_the_stream() {
        let mut bytes = vec![b'a', 0xFF, b'b', 0xC3];
        assert_eq!(take_whole_chars(&mut bytes), "a\u{fffd}b");
        assert_eq!(bytes, vec![0xC3], "an unfinished character is kept");
    }

    // ---------------------------------------------------------------- images --

    const PIXELS: [u8; 12] = [0; 12];

    fn images() -> [ImageInput<'static>; 1] {
        [ImageInput {
            width: 2,
            height: 2,
            rgb: &PIXELS,
        }]
    }

    fn with_images<'a>(
        mut req: GenerateRequest<'a>,
        images: &'a [ImageInput<'a>],
    ) -> GenerateRequest<'a> {
        req.images = images;
        req
    }

    #[test]
    fn an_image_is_prefilled_where_its_marker_stands_and_logits_come_from_the_last_text() {
        let mut fake = Fake::saying("ok");
        let cancel = Cancel::new();
        let prompt = format!("abcdef{MEDIA_MARKER}ghij");
        let images = images();
        let req = with_images(request(&prompt, &[], 8, &cancel), &images);
        let (generation, _) = collect(&mut fake, &req);
        assert_eq!(generation.text, "ok");
        // Text in chunks of four, the image between, then the rest.
        assert_eq!(
            fake.order,
            ["text:4", "text:2", "image:0", "text:4"],
            "the marker is not text"
        );
        assert_eq!(
            fake.lasts,
            [false, false, true],
            "only the final chunk wants logits"
        );
        // 6 + 4 text tokens and the image's 50.
        assert_eq!(generation.prompt_tokens, 60);
    }

    #[test]
    fn a_stop_before_the_image_is_encoded_never_encodes_it() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("ok");
        fake.cancel_after_prefill_chunks = Some((1, cancel.clone()));
        let prompt = format!("abcd{MEDIA_MARKER}efgh");
        let images = images();
        let req = with_images(request(&prompt, &[], 8, &cancel), &images);
        let (generation, pieces) = collect(&mut fake, &req);
        assert_eq!(generation.finish, Finish::Cancelled);
        assert!(pieces.is_empty());
        assert_eq!(fake.order, ["text:4"], "the encode was not started");
    }

    #[test]
    fn a_stop_during_the_encode_ends_before_the_rest_of_the_prompt_and_any_token() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("ok");
        fake.cancel_in_encode = Some(cancel.clone());
        let prompt = format!("abcd{MEDIA_MARKER}efgh");
        let images = images();
        let req = with_images(request(&prompt, &[], 8, &cancel), &images);
        let (generation, pieces) = collect(&mut fake, &req);
        assert_eq!(generation.finish, Finish::Cancelled);
        assert!(pieces.is_empty());
        assert_eq!(
            fake.order,
            ["text:4", "image:0"],
            "nothing after the encode"
        );
        assert_eq!(fake.at, 0, "no token was sampled");
    }

    #[test]
    fn an_image_that_cannot_fit_is_refused_before_any_work() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("ok");
        fake.context = 100;
        fake.image_cost = 120;
        let prompt = format!("ab{MEDIA_MARKER}cd");
        let images = images();
        let req = with_images(request(&prompt, &[], 8, &cancel), &images);
        let error = run(&mut fake, &req, &mut |_| Control::Continue).unwrap_err();
        assert_eq!(
            error,
            ModelError::ContextExceeded {
                needed: 125,
                held: 100
            }
        );
        assert!(fake.order.is_empty(), "nothing was prefilled");
    }

    #[test]
    fn markers_and_images_must_agree() {
        let cancel = Cancel::new();
        let mut fake = Fake::saying("ok");
        let lone = format!("a{MEDIA_MARKER}b");
        let none = request(&lone, &[], 8, &cancel);
        assert!(matches!(
            run(&mut fake, &none, &mut |_| Control::Continue),
            Err(ModelError::Generate(_))
        ));
        let images = images();
        let extra = with_images(request("no marker here", &[], 8, &cancel), &images);
        assert!(matches!(
            run(&mut fake, &extra, &mut |_| Control::Continue),
            Err(ModelError::Generate(_))
        ));
        let trailing = format!("a{MEDIA_MARKER}");
        let ends_in_image = with_images(request(&trailing, &[], 8, &cancel), &images);
        assert!(matches!(
            run(&mut fake, &ends_in_image, &mut |_| Control::Continue),
            Err(ModelError::Generate(_))
        ));
        assert!(fake.order.is_empty());
    }

    #[test]
    fn an_engine_with_no_projector_refuses_an_image_as_no_vision() {
        struct Blind(Fake);
        impl Backend for Blind {
            type Token = u16;
            fn tokenize(&self, text: &str) -> Result<Vec<u16>, ModelError> {
                self.0.tokenize(text)
            }
            fn context_size(&self) -> u32 {
                2048
            }
            fn chunk(&self) -> usize {
                4
            }
            fn prefill(&mut self, _: &[u16], _: bool) -> Result<(), ModelError> {
                Ok(())
            }
            fn sample(&mut self) -> Result<u16, ModelError> {
                Ok(END)
            }
            fn advance(&mut self, _: u16) -> Result<(), ModelError> {
                Ok(())
            }
            fn is_end(&self, token: u16) -> bool {
                token == END
            }
            fn piece(&self, _: u16, _: &mut Vec<u8>) {}
        }
        let cancel = Cancel::new();
        let prompt = format!("a{MEDIA_MARKER}b");
        let images = images();
        let req = with_images(request(&prompt, &[], 8, &cancel), &images);
        let error = run(&mut Blind(Fake::saying("")), &req, &mut |_| {
            Control::Continue
        })
        .unwrap_err();
        assert_eq!(error, ModelError::NoVision);
    }
}
