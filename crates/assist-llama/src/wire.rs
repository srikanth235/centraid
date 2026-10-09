//! THE LINES `assist-step` SPEAKS: one JSON request per line in, one JSON reply per line out.
//!
//! `assist-step` is the phone's decode step as a process, so a Python eval harness can score exactly what the phone
//! writes (`experiments/toolchat/native/eval/run.py --model gguf`). The wire is this module and nothing else — no
//! llama.cpp — so it is built, linted and tested by the PR gate; the binary adds the model.
//!
//! ```text
//! -> {"prompt": "<|im_start|>user\n…<|im_start|>assistant\n<think>\n", "dates": "dates: …", "think_limit": 200, "max_new": 512}
//! <- {"text": "<think>\n…</think>\n\n<tool_call>…", "think_cut": false, "rendered_call": true, "stopped": true,
//!     "new_tokens": 61, "think_tokens": 58, "prompt_tokens": 1304, "ms": 912}
//! <- {"error": "the model failed: …"}
//! ```
//!
//! `prompt` is required and rendered by the caller (the very renderer the phone's `native_turn` uses); `dates`,
//! `think_limit` and `max_new` are optional and default to the phone's ([`StepOptions::default`]). A request that does
//! not parse is answered with an `error` line and the next line is read: one bad request never ends a worker. Before
//! the first request the process writes one `ready` line (the model, the threads, the context), so a caller knows the
//! load finished and which engine settings it scores.

use centraid_assist::native::step::{StepOptions, StepOutput};
use serde::{Deserialize, Serialize};

/// One step to decode.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    /// The rendered prompt, ending where the model begins (`<|im_start|>assistant\n<think>\n`).
    pub prompt: String,
    /// The `dates:` line of the turn's user message, when it has one.
    #[serde(default)]
    pub dates: Option<String>,
    /// The most think tokens before `</think>` is written for the model.
    #[serde(default)]
    pub think_limit: Option<u32>,
    /// The most tokens of the whole message.
    #[serde(default)]
    pub max_new: Option<u32>,
}

impl Request {
    /// The decode options of this request: the phone's, with the two limits the request overrides. Always greedy.
    #[must_use]
    pub fn options(&self) -> StepOptions {
        let phone = StepOptions::default();
        StepOptions {
            think_limit: self.think_limit.unwrap_or(phone.think_limit),
            max_new: self.max_new.unwrap_or(phone.max_new),
            temperature: phone.temperature,
        }
    }
}

/// Read one request line.
///
/// # Errors
/// The words of the `error` reply when the line is not a JSON object of a [`Request`].
pub fn parse_request(line: &str) -> Result<Request, String> {
    serde_json::from_str(line).map_err(|error| format!("not a step request: {error}"))
}

/// What a decoded step reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reply {
    pub text: String,
    pub think_cut: bool,
    pub rendered_call: bool,
    pub stopped: bool,
    pub new_tokens: Option<u32>,
    pub think_tokens: Option<u32>,
    /// Tokens of the prompt the first generation (the think) was given; `None` when the step ran no generation.
    pub prompt_tokens: Option<u32>,
    /// Wall time of the step, in milliseconds.
    pub ms: u64,
}

impl Reply {
    #[must_use]
    pub fn of(output: StepOutput, prompt_tokens: Option<u32>, ms: u64) -> Self {
        Self {
            text: output.text,
            think_cut: output.info.think_cut,
            rendered_call: output.info.rendered_call,
            stopped: output.info.stopped,
            new_tokens: output.info.new_tokens,
            think_tokens: output.info.think_tokens,
            prompt_tokens,
            ms,
        }
    }

    /// The reply as its line (no trailing newline).
    #[must_use]
    pub fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|error| error_line(&error.to_string()))
    }
}

/// An `error` reply as its line.
#[must_use]
pub fn error_line(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

/// The `ready` line: written once, after the model has loaded.
#[must_use]
pub fn ready_line(model: &str, threads: i32, context: u32) -> String {
    serde_json::json!({ "ready": true, "model": model, "threads": threads, "context": context })
        .to_string()
}

#[cfg(test)]
mod tests {
    use centraid_assist::native::step::StepInfo;
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn a_request_with_only_a_prompt_decodes_under_the_phones_options() {
        let request = parse_request(r#"{"prompt": "<|im_start|>assistant\n<think>\n"}"#).unwrap();
        assert_eq!(request.prompt, "<|im_start|>assistant\n<think>\n");
        assert_eq!(request.dates, None);
        assert_eq!(request.options(), StepOptions::default());
        assert!(request.options().temperature.abs() < f32::EPSILON, "greedy");
    }

    #[test]
    fn the_limits_a_request_names_override_and_the_rest_stay_the_phones() {
        let request = parse_request(
            r#"{"prompt": "p", "dates": "dates: today = 2026-03-16", "think_limit": 50}"#,
        )
        .unwrap();
        assert_eq!(request.dates.as_deref(), Some("dates: today = 2026-03-16"));
        let options = request.options();
        assert_eq!(options.think_limit, 50);
        assert_eq!(options.max_new, StepOptions::default().max_new);
        let request = parse_request(r#"{"prompt": "p", "dates": null, "max_new": 8}"#).unwrap();
        assert_eq!(request.dates, None);
        assert_eq!(request.options().max_new, 8);
    }

    #[test]
    fn a_line_that_is_not_a_request_is_an_error_and_not_a_guess() {
        for bad in [
            "",
            "not json",
            "[]",
            r#"{"dates": "x"}"#,
            r#"{"prompt": 3}"#,
            r#"{"prompt": "p", "think_limit": -1}"#,
            r#"{"prompt": "p", "temperature": 0.6}"#,
        ] {
            let error = parse_request(bad).expect_err(bad);
            assert!(error.starts_with("not a step request"), "{bad}: {error}");
        }
    }

    #[test]
    fn a_reply_is_one_line_with_every_field_the_harness_reads() {
        let output = StepOutput {
            text: "<think>\nintent: read\n</think>\n\n<tool_call>\n{}\n</tool_call>".to_owned(),
            info: StepInfo {
                think_cut: true,
                rendered_call: true,
                stopped: true,
                cancelled: false,
                think_tokens: Some(7),
                new_tokens: Some(9),
            },
        };
        let line = Reply::of(output.clone(), Some(1304), 912).line();
        assert!(
            !line.contains('\n'),
            "a reply is one line even when the text is not"
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            value,
            json!({
                "text": output.text,
                "think_cut": true,
                "rendered_call": true,
                "stopped": true,
                "new_tokens": 9,
                "think_tokens": 7,
                "prompt_tokens": 1304,
                "ms": 912,
            })
        );
    }

    #[test]
    fn counts_the_engine_did_not_report_are_null() {
        let output = StepOutput {
            text: "<think>\n".to_owned(),
            info: StepInfo::default(),
        };
        let value: Value = serde_json::from_str(&Reply::of(output, None, 0).line()).unwrap();
        assert_eq!(value["new_tokens"], Value::Null);
        assert_eq!(value["prompt_tokens"], Value::Null);
    }

    #[test]
    fn errors_and_the_ready_line_are_objects_a_harness_can_tell_apart() {
        let error: Value = serde_json::from_str(&error_line("it \"broke\"\n")).unwrap();
        assert_eq!(error, json!({ "error": "it \"broke\"\n" }));
        let ready: Value = serde_json::from_str(&ready_line("m.gguf", 4, 8192)).unwrap();
        assert_eq!(
            ready,
            json!({ "ready": true, "model": "m.gguf", "threads": 4, "context": 8192 })
        );
    }
}
