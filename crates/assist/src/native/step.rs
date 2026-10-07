//! THE FREE DECODE STEP (SPEC §6.6, §9; #1088, D-1044-18): one assistant message, written by any [`Model`].
//!
//! The model writes text and the runtime reads it; nothing is masked (no grammar). Three things generation does not do
//! by itself are done here, as steps over TEXT, which is the only thing an engine behind the [`Model`] trait takes:
//!
//! 1. **the think guard**: the think is generated with `</think>` as the stop string and `think_limit` tokens at most; a think
//!    that hit the limit is closed with `</think>` ([`StepInfo::think_cut`]);
//! 2. **the rendered call**: once the think is closed, the call is not sampled but written by
//!    [`compile_think`](crate::native::think::compile_think), the very function the data builder checks against every authored
//!    call, and appended as `\n\n` plus the call text ([`StepInfo::rendered_call`]); a think that does not state a whole call
//!    leaves the call to the model;
//! 3. **one call per message**: the free continuation stops at `</tool_call>`, and the message ends with it.
//!
//! This is `experiments/toolchat/native/train/decode.py`'s `_Step` for the same model behaviour: that one forces tokens
//! inside HF `generate`, this one cuts and continues the text, so the message text is the same wherever the model
//! writes the same think. Two things an engine behind [`Model`] does not tell, and the step reads from the text:
//!
//! - a [`Finish::Stop`] does not say whether the stop string or the end-of-turn token ended the generation. The think's
//!   is taken as closed; the continuation's as `</tool_call>` when the text it wrote holds a `<tool_call>` that was
//!   never closed (the stop string is not part of the text, and is put back);
//! - an engine counts the tokens it generates; the forced call is text, so the counts of [`StepInfo`] are the engine's,
//!   plus the one `</think>` a cut think is closed with. The message's budget (`max_new`) is spent on those counts: it ends a
//!   think that would run past it (no `</think>` is written) and bounds the continuation. The rendered call is never cut by
//!   it, where HF `generate` would cut the forced tokens at the budget; the default budget (512) holds the longest think
//!   (200) and the longest call there is.
//!
//! The prompt ends where the model begins: `<|im_start|>assistant\n<think>\n` (a prompt that ends at the header gets the
//! `<think>\n`), optionally followed by the first lines of the think, given (`retry: <slot>\n` after the runtime refused a
//! slot); the message returned starts with `<think>\n` and includes them.

use crate::model::{Cancel, Control, Finish, GenerateRequest, Generation, Model, ModelError};
use crate::native::identity::MODEL;
use crate::native::think::{TraceMode, compile_think};
use crate::native::transcript::{assistant_header, assistant_open, call_text_of, py_strip};

/// Think tokens before `</think>` is forced.
pub const THINK_LIMIT: u32 = 200;
/// Tokens a whole message may take.
pub const MAX_NEW: u32 = 512;

/// What a step is allowed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepOptions {
    /// The most think tokens; `</think>` is written for the model after them.
    pub think_limit: u32,
    /// The most tokens of the whole message (the think, `</think>`, and the model's own call when the think states none).
    pub max_new: u32,
    /// `0.0` is greedy; rollouts sample (Python: 0.6).
    pub temperature: f32,
}

impl Default for StepOptions {
    fn default() -> Self {
        Self {
            think_limit: THINK_LIMIT,
            max_new: MAX_NEW,
            temperature: 0.0,
        }
    }
}

/// What happened in a step.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepInfo {
    /// The think hit `think_limit` and `</think>` was written for the model.
    pub think_cut: bool,
    /// The call is the one the think states, not the model's.
    pub rendered_call: bool,
    /// The message ended on its own (the one call, or the model's end of turn), not on the token budget or a cancel.
    pub stopped: bool,
    /// [`Cancel`] was set: `text` is what was written so far.
    pub cancelled: bool,
    /// Tokens the engine reports for the think (its stop string included, when it counts it).
    pub think_tokens: Option<u32>,
    /// Tokens the engine reports for the message, plus the `</think>` a cut think was closed with.
    pub new_tokens: Option<u32>,
}

/// One assistant message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOutput {
    /// The whole message, from `<think>\n` (the given prefix included) to the end of the call. No `<|im_end|>`.
    pub text: String,
    pub info: StepInfo,
}

fn generate(
    model: &dyn Model,
    prompt: &str,
    stop: &str,
    max_tokens: u32,
    temperature: f32,
    cancel: &Cancel,
) -> Result<Generation, ModelError> {
    let stops = [stop];
    model.generate(
        &GenerateRequest {
            prompt,
            grammar: None,
            max_tokens,
            stop: &stops,
            temperature,
            cancel,
            images: &[],
        },
        &mut |_| Control::Continue,
    )
}

/// The prompt ready for the model, and the think's given prefix: the text after the last `<think>\n` of the prompt.
fn open_of(prompt: &str) -> Result<(String, &str), ModelError> {
    let header = assistant_header();
    let open = assistant_open();
    if prompt.ends_with(&header) {
        return Ok((format!("{prompt}{}", MODEL.think_open), ""));
    }
    match prompt.rfind(&open) {
        Some(at) => Ok((prompt.to_owned(), &prompt[at + open.len()..])),
        None => Err(ModelError::Generate(
            "a step's prompt ends with the assistant header and `<think>` (plus the think's given prefix)".to_owned(),
        )),
    }
}

/// One assistant message for a rendered `prompt`.
///
/// `dates` is the `dates:` line of the turn's message (what a `dates[i]` of the think is read against; `None` when the
/// prompt has none) and `mode` how a think with no construct of either trace version is read.
///
/// # Errors
/// [`ModelError`] when the engine fails, or when `prompt` does not end where a step begins. A cancelled step is `Ok`,
/// with [`StepInfo::cancelled`] set and the text so far.
pub fn decode_step(
    model: &dyn Model,
    prompt: &str,
    dates: Option<&str>,
    mode: TraceMode,
    opts: StepOptions,
    cancel: &Cancel,
) -> Result<StepOutput, ModelError> {
    let (prompt, prefix) = open_of(prompt)?;
    let mut text = format!("{}{prefix}", MODEL.think_open);
    let mut info = StepInfo::default();
    let cancelled = |text: String, mut info: StepInfo| {
        info.cancelled = true;
        StepOutput { text, info }
    };
    if cancel.is_cancelled() {
        return Ok(cancelled(text, info));
    }

    // 1. the think, under the guard (and under the message's own token budget)
    let mut think = String::new();
    let mut used = 0u32;
    let budget_ends_think = opts.max_new <= opts.think_limit;
    let think_cap = opts.think_limit.min(opts.max_new);
    if think_cap == 0 {
        info.think_cut = !budget_ends_think;
        info.think_tokens = Some(0);
        info.new_tokens = Some(0);
        if budget_ends_think {
            return Ok(StepOutput { text, info });
        }
    } else {
        let generation = generate(
            model,
            &prompt,
            MODEL.think_close,
            think_cap,
            opts.temperature,
            cancel,
        )?;
        think = generation.text;
        used = generation.generated_tokens;
        info.think_tokens = Some(generation.generated_tokens);
        match generation.finish {
            Finish::Cancelled => {
                text.push_str(&think);
                info.new_tokens = Some(used);
                return Ok(cancelled(text, info));
            }
            // the message's budget ran out inside the think: there is no `</think>` to write
            Finish::Length if budget_ends_think => {
                text.push_str(&think);
                info.new_tokens = Some(used);
                return Ok(StepOutput { text, info });
            }
            Finish::Length => info.think_cut = true,
            Finish::Stop => {}
        }
    }
    if info.think_cut {
        used = used.saturating_add(1); // the `</think>` written for the model
    }
    text.push_str(&think);
    text.push_str(MODEL.think_close);
    info.new_tokens = Some(used);
    if used >= opts.max_new {
        return Ok(StepOutput { text, info }); // the `</think>` was the message's last token
    }

    // 2. the call the think states, written by the compiler
    let stated = format!("{prefix}{think}");
    if let Ok(call) = compile_think(py_strip(&stated), dates, mode) {
        text.push_str("\n\n");
        text.push_str(&call_text_of(&call));
        info.rendered_call = true;
        info.stopped = true;
        return Ok(StepOutput { text, info });
    }

    // 3. the model's own message, up to its one call
    let left = opts.max_new - used;
    if cancel.is_cancelled() {
        return Ok(cancelled(text, info));
    }
    let continued = format!("{prompt}{think}{}", MODEL.think_close);
    let generation = generate(
        model,
        &continued,
        MODEL.tool_call_close,
        left,
        opts.temperature,
        cancel,
    )?;
    info.new_tokens = Some(used.saturating_add(generation.generated_tokens));
    text.push_str(&generation.text);
    match generation.finish {
        Finish::Cancelled => return Ok(cancelled(text, info)),
        Finish::Length => {}
        Finish::Stop => {
            info.stopped = true;
            // the stop string is not part of the text: put it back when it is what ended an open call
            let open = generation.text.rfind(MODEL.tool_call_open);
            let close = generation.text.rfind(MODEL.tool_call_close);
            if open.is_some() && open > close {
                text.push_str(MODEL.tool_call_close);
            }
        }
    }
    Ok(StepOutput { text, info })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::testing::ScriptedModel;

    /// A think that states a whole call: `train/test_trace3.py`'s `StepRendersTheCall`.
    const THINK: &str = "intent: read \"what's on\"\nkind: event\nwhere: status = \"open\"\norder: date asc\nlimit: 1";
    const OPEN: &str = "<|im_start|>assistant\n<think>\n";
    const DATES: &str = "dates: next week = 2026-03-16..2026-03-22";

    fn prompt() -> String {
        format!("<|im_start|>user\nwhat is on\n<|im_end|>\n{OPEN}")
    }

    fn call_of(think: &str, dates: Option<&str>) -> String {
        call_text_of(&compile_think(think, dates, TraceMode::V4).expect("the think states a call"))
    }

    fn step(model: &dyn Model, prompt: &str, dates: Option<&str>) -> StepOutput {
        decode_step(
            model,
            prompt,
            dates,
            TraceMode::V4,
            StepOptions::default(),
            &Cancel::new(),
        )
        .expect("a step")
    }

    /// An engine that answers each request with a scripted text and finish (which `ScriptedModel` does not: it only stops).
    struct Engine {
        script: Mutex<Vec<(String, Finish, u32)>>,
        seen: Mutex<Vec<(String, Vec<String>, u32)>>,
    }

    impl Engine {
        fn new(script: &[(&str, Finish, u32)]) -> Self {
            Self {
                script: Mutex::new(
                    script
                        .iter()
                        .rev()
                        .map(|(text, finish, n)| ((*text).to_owned(), *finish, *n))
                        .collect(),
                ),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn seen(&self) -> Vec<(String, Vec<String>, u32)> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Model for Engine {
        fn generate(
            &self,
            request: &GenerateRequest<'_>,
            _: &mut dyn FnMut(&str) -> Control,
        ) -> Result<Generation, ModelError> {
            self.seen.lock().unwrap().push((
                request.prompt.to_owned(),
                request.stop.iter().map(|s| (*s).to_owned()).collect(),
                request.max_tokens,
            ));
            let (text, finish, generated_tokens) = self
                .script
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| ModelError::Generate("the script is spent".to_owned()))?;
            Ok(Generation {
                text,
                finish,
                prompt_tokens: 0,
                generated_tokens,
            })
        }
    }

    #[test]
    fn a_think_that_states_a_call_gets_the_call_rendered_and_the_message_ends() {
        let model = ScriptedModel::new([format!("{THINK}\n")]);
        let out = step(&model, &prompt(), None);
        let call = call_of(THINK, None);
        assert!(call.contains("<function=answer>"), "{call}");
        assert_eq!(out.text, format!("<think>\n{THINK}\n</think>\n\n{call}"));
        assert!(out.info.rendered_call && out.info.stopped);
        assert!(!out.info.think_cut && !out.info.cancelled);
        // one generation: the think, stopped at `</think>`, 200 tokens at most; nothing asks for the call
        let requests = model.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].prompt, prompt());
        assert_eq!(requests[0].stop, ["</think>"]);
        assert_eq!(requests[0].max_tokens, 200);
        assert_eq!(requests[0].grammar, None);
    }

    #[test]
    fn the_think_guard_closes_a_think_that_hits_the_limit() {
        let engine = Engine::new(&[("one two three", Finish::Length, 3), ("", Finish::Stop, 1)]);
        let opts = StepOptions {
            think_limit: 3,
            ..StepOptions::default()
        };
        let out = decode_step(
            &engine,
            &prompt(),
            None,
            TraceMode::V4,
            opts,
            &Cancel::new(),
        )
        .unwrap();
        assert!(out.info.think_cut);
        assert!(
            out.text.starts_with("<think>\none two three</think>"),
            "{}",
            out.text
        );
        assert_eq!(out.info.think_tokens, Some(3));
        let seen = engine.seen();
        assert_eq!(seen[0].2, 3, "the think is asked for at most the limit");
        // the model goes on from the closed think, with the `</think>` that was written for it, and what is left of the budget
        assert_eq!(seen[1].0, format!("{}one two three</think>", prompt()));
        assert_eq!(seen[1].2, 512 - 3 - 1);
    }

    #[test]
    fn a_cut_think_that_states_a_call_still_gets_it_rendered() {
        // the limit fell after the last slot: the cut think is the whole trace
        let engine = Engine::new(&[(THINK, Finish::Length, 200)]);
        let out = step(&engine, &prompt(), None);
        assert!(out.info.think_cut && out.info.rendered_call);
        assert_eq!(
            out.text,
            format!("<think>\n{THINK}</think>\n\n{}", call_of(THINK, None))
        );
        assert_eq!(engine.seen().len(), 1);
    }

    #[test]
    fn a_think_that_states_no_call_leaves_the_call_to_the_model() {
        // an act with no verb, and no trace at all
        for think in ["intent: write\nkind: event", "what is on friday"] {
            let call = "\n\n<tool_call>\n<function=answer>\n<parameter=rows>\n#1\n</parameter>\n</function>\n";
            let engine = Engine::new(&[(think, Finish::Stop, 9), (call, Finish::Stop, 20)]);
            let out = step(&engine, &prompt(), None);
            assert!(!out.info.rendered_call, "{think}");
            // the stop string is put back: one call per message, which ends with `</tool_call>`
            assert_eq!(
                out.text,
                format!("<think>\n{think}</think>{call}</tool_call>")
            );
            assert!(out.info.stopped);
            let seen = engine.seen();
            assert_eq!(seen[1].0, format!("{}{think}</think>", prompt()));
            assert_eq!(seen[1].1, ["</tool_call>"]);
            assert_eq!(seen[1].2, 512 - 9);
            assert_eq!(out.info.new_tokens, Some(29));
        }
    }

    #[test]
    fn the_message_ends_with_the_one_call_whatever_the_model_would_add() {
        // the model closes its call: the engine stops there and does not return the stop string
        let engine = Engine::new(&[
            ("what is on friday", Finish::Stop, 5),
            (
                "\n\n<tool_call>\n<function=answer>\n</function>\n",
                Finish::Stop,
                12,
            ),
        ]);
        let out = step(&engine, &prompt(), None);
        assert!(
            out.text.ends_with("</function>\n</tool_call>"),
            "{}",
            out.text
        );
        // a plain reply with no call in it ends on the end of turn: nothing is put back
        let engine = Engine::new(&[
            ("no tool fits", Finish::Stop, 3),
            ("\n\nNothing to do.", Finish::Stop, 6),
        ]);
        let out = step(&engine, &prompt(), None);
        assert_eq!(out.text, "<think>\nno tool fits</think>\n\nNothing to do.");
        assert!(out.info.stopped);
        // a call that runs into the token budget stays open
        let engine = Engine::new(&[
            ("no tool fits", Finish::Stop, 3),
            ("\n\n<tool_call>\n<func", Finish::Length, 509),
        ]);
        let out = step(&engine, &prompt(), None);
        assert_eq!(
            out.text,
            "<think>\nno tool fits</think>\n\n<tool_call>\n<func"
        );
        assert!(!out.info.stopped);
    }

    #[test]
    fn a_spent_budget_leaves_the_call_unwritten() {
        let engine = Engine::new(&[("no tool fits", Finish::Stop, 512)]);
        let out = step(&engine, &prompt(), None);
        assert_eq!(out.text, "<think>\nno tool fits</think>");
        assert!(!out.info.stopped);
        assert_eq!(engine.seen().len(), 1);
    }

    #[test]
    fn a_message_budget_smaller_than_the_think_limit_ends_inside_the_think() {
        // HF `generate` stops at `max_new_tokens` whatever the guard: no `</think>` is written, and it is no cut
        let engine = Engine::new(&[("intent: re", Finish::Length, 10)]);
        let opts = StepOptions {
            max_new: 10,
            ..StepOptions::default()
        };
        let out = decode_step(
            &engine,
            &prompt(),
            None,
            TraceMode::V4,
            opts,
            &Cancel::new(),
        )
        .unwrap();
        assert_eq!(engine.seen()[0].2, 10);
        assert_eq!(out.text, "<think>\nintent: re");
        assert!(!out.info.think_cut && !out.info.stopped && !out.info.rendered_call);
        assert_eq!(engine.seen().len(), 1);
    }

    #[test]
    fn a_closing_think_that_spends_the_budget_leaves_no_call() {
        // the think ends on the message's last token: nothing more is generated, and no call is rendered
        let engine = Engine::new(&[(THINK, Finish::Stop, 7)]);
        let opts = StepOptions {
            max_new: 7,
            ..StepOptions::default()
        };
        let out = decode_step(
            &engine,
            &prompt(),
            None,
            TraceMode::V4,
            opts,
            &Cancel::new(),
        )
        .unwrap();
        assert_eq!(out.text, format!("<think>\n{THINK}</think>"));
        assert!(!out.info.rendered_call && !out.info.stopped);
    }

    #[test]
    fn a_given_prefix_is_part_of_the_think_and_of_the_message() {
        let (head, tail) = THINK.split_once("kind: ").unwrap();
        let given = head;
        let model = ScriptedModel::new([format!("kind: {tail}")]);
        let out = step(&model, &format!("{}{given}", prompt()), None);
        assert_eq!(model.prompts(), [format!("{}{given}", prompt())]);
        assert_eq!(
            out.text,
            format!("<think>\n{THINK}</think>\n\n{}", call_of(THINK, None))
        );
        assert!(out.info.rendered_call);
        // the retry lines of the runtime: the model writes what follows them
        let retry = "retry: where\n";
        let model = ScriptedModel::new(["intent: read \"x\"\nkind: event"]);
        let out = step(&model, &format!("{}{retry}", prompt()), None);
        assert!(
            out.text.starts_with("<think>\nretry: where\nintent: read"),
            "{}",
            out.text
        );
    }

    #[test]
    fn a_header_only_prompt_is_opened_with_the_think() {
        let model = ScriptedModel::new([THINK]);
        step(
            &model,
            "<|im_start|>user\nq<|im_end|>\n<|im_start|>assistant\n",
            None,
        );
        assert_eq!(
            model.prompts(),
            ["<|im_start|>user\nq<|im_end|>\n<|im_start|>assistant\n<think>\n"]
        );
    }

    #[test]
    fn a_prompt_that_does_not_end_where_a_step_begins_is_refused() {
        let model = ScriptedModel::empty();
        let refused = decode_step(
            &model,
            "<|im_start|>user\nq<|im_end|>\n",
            None,
            TraceMode::V4,
            StepOptions::default(),
            &Cancel::new(),
        );
        assert!(matches!(refused, Err(ModelError::Generate(_))));
        assert!(model.requests().is_empty());
    }

    #[test]
    fn the_dates_line_is_what_a_date_of_the_think_is_read_against() {
        let think = "intent: read \"what's on\"\nkind: event\nwhen: \"next week\" = dates[0]";
        let with = ScriptedModel::new([think]);
        let out = step(&with, &prompt(), Some(DATES));
        assert!(out.info.rendered_call, "{}", out.text);
        assert_eq!(
            out.text,
            format!(
                "<think>\n{think}</think>\n\n{}",
                call_of(think, Some(DATES))
            )
        );
        // without the line the think states no whole call: the model goes on
        let without = Engine::new(&[(think, Finish::Stop, 7), ("", Finish::Stop, 1)]);
        let out = step(&without, &prompt(), None);
        assert!(!out.info.rendered_call);
        assert_eq!(without.seen().len(), 2);
    }

    #[test]
    fn the_mode_asked_for_is_the_compilers() {
        // a v3.1 trace of the authored data (`scope`, `refer`, a `week+1 wd5` date) is read as that version in either mode, and
        // a v4 one (a one-row `pick`) likewise: both stay readable, and the step writes what the compiler writes for the mode
        let v31 = "intent: write \"cancel\"\nverb: cancel\nscope: one\nrefer: none\nkind: event\nname: Night shift\nwhen: \"friday\" = week+1 wd5\n";
        for mode in [TraceMode::V31, TraceMode::V4] {
            let model = ScriptedModel::new([v31]);
            let out = decode_step(
                &model,
                &prompt(),
                None,
                mode,
                StepOptions::default(),
                &Cancel::new(),
            )
            .unwrap();
            let want = compile_think(py_strip(v31), None, mode).expect("the think states a call");
            assert!(out.info.rendered_call, "{mode:?}: {}", out.text);
            assert_eq!(
                out.text,
                format!("<think>\n{v31}</think>\n\n{}", call_text_of(&want))
            );
        }
    }

    #[test]
    fn sampling_options_reach_the_engine() {
        let model = ScriptedModel::new([THINK]);
        let opts = StepOptions {
            temperature: 0.6,
            ..StepOptions::default()
        };
        decode_step(&model, &prompt(), None, TraceMode::V4, opts, &Cancel::new()).unwrap();
        assert!((model.requests()[0].temperature - 0.6).abs() < f32::EPSILON);
    }

    #[test]
    fn a_stop_before_the_step_asks_nothing_of_the_engine() {
        let model = ScriptedModel::new([THINK]);
        let cancel = Cancel::new();
        cancel.cancel();
        let out = decode_step(
            &model,
            &prompt(),
            None,
            TraceMode::V4,
            StepOptions::default(),
            &cancel,
        )
        .unwrap();
        assert!(out.info.cancelled && !out.info.stopped);
        assert_eq!(out.text, "<think>\n");
        assert!(model.requests().is_empty());
    }

    #[test]
    fn a_stop_during_the_think_returns_the_text_so_far() {
        let model = ScriptedModel::new([THINK]).cancelling_during(0, 2);
        let out = decode_step(
            &model,
            &prompt(),
            None,
            TraceMode::V4,
            StepOptions::default(),
            &Cancel::new(),
        )
        .unwrap();
        assert!(out.info.cancelled && !out.info.rendered_call);
        assert!(out.text.starts_with("<think>\n"));
        assert!(!out.text.contains("</think>"), "{}", out.text);
    }

    #[test]
    fn a_stop_between_the_think_and_the_continuation_is_honoured() {
        /// Sets the cancel token once its first generation is done.
        struct StopsAfterTheThink(Cancel, Mutex<u32>);
        impl Model for StopsAfterTheThink {
            fn generate(
                &self,
                _: &GenerateRequest<'_>,
                _: &mut dyn FnMut(&str) -> Control,
            ) -> Result<Generation, ModelError> {
                *self.1.lock().unwrap() += 1;
                self.0.cancel();
                Ok(Generation {
                    text: "what is on friday".to_owned(),
                    finish: Finish::Stop,
                    prompt_tokens: 0,
                    generated_tokens: 5,
                })
            }
        }
        let cancel = Cancel::new();
        let model = StopsAfterTheThink(cancel.clone(), Mutex::new(0));
        let out = decode_step(
            &model,
            &prompt(),
            None,
            TraceMode::V4,
            StepOptions::default(),
            &cancel,
        )
        .unwrap();
        assert!(out.info.cancelled);
        assert_eq!(
            *model.1.lock().unwrap(),
            1,
            "the continuation is not asked for"
        );
        assert_eq!(out.text, "<think>\nwhat is on friday</think>");
    }

    #[test]
    fn an_engine_failure_is_the_steps() {
        let model = ScriptedModel::empty();
        let failed = decode_step(
            &model,
            &prompt(),
            None,
            TraceMode::V4,
            StepOptions::default(),
            &Cancel::new(),
        );
        assert!(matches!(failed, Err(ModelError::Generate(_))));
    }
}
