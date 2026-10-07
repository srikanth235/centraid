//! THE CONVERSATION THE MODEL READS: the system turn, every user turn with its block, every
//! message the model wrote (thinking kept) and every observation, in the order they happened.
//!
//! This is `eval/lib.py`'s `Transcript` plus `train/hf_backend.py`'s `prompt_from_history`, in Rust:
//! the runtime hands the loop its system turn (`Session::prompt`) and, per user message, a block and
//! the observations it compacted; the loop appends what the model wrote and what the runtime
//! answered, and renders the lot with [`crate::native::transcript`], the one renderer the training
//! data is made with. A message the model wrote that is not exactly one think and one well-formed
//! call is not a record the renderer can write byte for byte, so it is spliced in as it was said,
//! under the renderer's own framing, and the history around it is rendered in segments.

use crate::native::identity::MODEL;
use crate::native::transcript::{
    self, Json, Message, assistant_open, py_strip, render, render_prompt_for_generation,
};

/// One entry of the conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    /// A user turn: the message and the runtime's block that precedes it.
    User { text: String, block: Option<String> },
    /// What the model wrote, as it wrote it (up to its one call).
    Assistant(String),
    /// What the runtime answered. `obs` is the runtime's index of the observation, which a later
    /// compaction names to replace this text.
    Tool { obs: Option<usize>, text: String },
}

/// The conversation of one chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Log {
    /// The runtime's system turn, rendered (`Session::prompt()["rendered"]`).
    system: String,
    entries: Vec<Entry>,
}

impl Log {
    #[must_use]
    pub fn new(system: String) -> Self {
        Self {
            system,
            entries: Vec::new(),
        }
    }

    /// The system turn as the model reads it.
    #[must_use]
    pub fn system(&self) -> &str {
        &self.system
    }

    /// How many entries the conversation holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn user(&mut self, text: &str, block: Option<&str>) {
        self.entries.push(Entry::User {
            text: text.to_owned(),
            block: block.map(str::to_owned),
        });
    }

    pub fn assistant(&mut self, message: &str) {
        self.entries.push(Entry::Assistant(message.to_owned()));
    }

    pub fn tool(&mut self, obs: Option<usize>, text: &str) {
        self.entries.push(Entry::Tool {
            obs,
            text: text.to_owned(),
        });
    }

    /// Replace the observations the runtime compacted (`Session::user`'s `compacted`, a list of
    /// `{obs, text}`), in place.
    pub fn compact(&mut self, notices: &serde_json::Value) {
        for notice in notices.as_array().into_iter().flatten() {
            let (Some(obs), Some(text)) = (notice["obs"].as_u64(), notice["text"].as_str()) else {
                continue;
            };
            for entry in &mut self.entries {
                if let Entry::Tool {
                    obs: Some(at),
                    text: held,
                } = entry
                    && *at as u64 == obs
                {
                    text.clone_into(held);
                }
            }
        }
    }

    /// The prompt for the model's next message: the system turn, the history, and
    /// `<|im_start|>assistant\n<think>\n`.
    ///
    /// # Errors
    /// The renderer's refusal, which a log built through this API cannot provoke.
    pub fn prompt(&self) -> Result<String, String> {
        let mut out = self.system.clone();
        let mut segment: Vec<Message> = Vec::new();
        for entry in &self.entries {
            match entry {
                Entry::User { text, block } => segment.push(Message::user(
                    &transcript::user_content(text, block.as_deref()),
                )),
                Entry::Tool { text, .. } => segment.push(Message::tool(text)),
                Entry::Assistant(said) => match assistant_record(said) {
                    Some(record) => segment.push(record),
                    None => {
                        out.push_str(&render(&segment).map_err(|e| e.to_string())?.text);
                        segment.clear();
                        let raw = said.strip_prefix(MODEL.think_open).unwrap_or(said);
                        out.push_str(&assistant_open());
                        out.push_str(raw);
                        out.push_str(MODEL.im_end);
                        out.push('\n');
                    }
                },
            }
        }
        out.push_str(&render_prompt_for_generation(&segment).map_err(|e| e.to_string())?);
        Ok(out)
    }
}

/// A raw assistant message as a record the renderer writes back byte for byte: one think, then
/// exactly one well-formed call. `None` for anything else (`hf_backend.assistant_record`).
#[must_use]
pub fn assistant_record(said: &str) -> Option<Message> {
    let body = said.strip_prefix(MODEL.think_open).unwrap_or(said);
    if body.matches(MODEL.think_close).count() != 1 {
        return None;
    }
    let (think, rest) = body.split_once(MODEL.think_close)?;
    let rest = rest.trim_matches('\n');
    let rest = rest
        .strip_prefix(MODEL.tool_call_open)?
        .strip_prefix('\n')?;
    let rest = rest.strip_prefix(MODEL.function_open)?;
    let (tool, mut rest) = rest.split_once(">\n")?;
    if tool.is_empty() || !tool.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        return None;
    }
    let tail = format!("{}\n{}", MODEL.function_close, MODEL.tool_call_close);
    let mut args: Vec<(String, Json)> = Vec::new();
    loop {
        if rest == tail {
            break;
        }
        let after = rest.strip_prefix(MODEL.parameter_open)?;
        let (key, after) = after.split_once(">\n")?;
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return None;
        }
        // the value runs to the first closing tag, which must follow a newline and precede one
        let close = after.find(MODEL.parameter_close)?;
        let value = after[..close].strip_suffix('\n')?;
        rest = after[close + MODEL.parameter_close.len()..].strip_prefix('\n')?;
        args.push((key.to_owned(), Json::str(value)));
    }
    Some(Message::Assistant {
        think: py_strip(think).to_owned(),
        tool: tool.to_owned(),
        args,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYSTEM: &str = "<|im_start|>system\nsystem text<|im_end|>\n";

    fn call(tool: &str, args: &[(&str, &str)]) -> String {
        let args: Vec<(String, Json)> = args
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Json::str(v)))
            .collect();
        transcript::call_text(tool, &args)
    }

    fn said(think: &str, tool: &str, args: &[(&str, &str)]) -> String {
        format!("<think>\n{think}\n</think>\n\n{}", call(tool, args))
    }

    #[test]
    fn a_well_formed_message_is_a_record_that_renders_back_byte_for_byte() {
        let raw = said("intent: read", "find", &[("kind", "task"), ("limit", "3")]);
        let record = assistant_record(&raw).expect("a record");
        let rendered = render(&[record]).unwrap().text;
        assert_eq!(
            rendered,
            format!(
                "{}{}\n",
                assistant_open(),
                raw.strip_prefix(MODEL.think_open).unwrap().to_owned() + MODEL.im_end
            )
        );
    }

    #[test]
    fn a_value_with_lines_and_the_order_of_the_arguments_are_kept() {
        let raw = said(
            "plan: write",
            "act",
            &[
                ("verb", "create"),
                ("kind", "task"),
                ("args", "name: x\ndate: y"),
            ],
        );
        let Some(Message::Assistant { args, .. }) = assistant_record(&raw) else {
            panic!("a record");
        };
        let keys: Vec<&str> = args.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["verb", "kind", "args"]);
        assert_eq!(args[2].1.arg_text(), "name: x\ndate: y");
    }

    #[test]
    fn what_is_not_one_think_and_one_call_is_not_a_record() {
        for odd in [
            "<think>\nno call</think>\n\nNothing to do.",
            "<think>\none</think>\n\n<think>two</think>\n\n<tool_call>",
            "<think>\nopen</think>\n\n<tool_call>\n<function=find>\n<parameter=kind>\ntask\n</parameter>\n</function>\n",
            "no think at all",
            "<think>\nx</think>\n\n<tool_call>\n<function=Find>\n</function>\n</tool_call>",
        ] {
            assert!(assistant_record(odd).is_none(), "{odd}");
        }
    }

    #[test]
    fn the_prompt_is_the_system_turn_the_history_and_the_open_think() {
        let mut log = Log::new(SYSTEM.to_owned());
        log.user("what is due", Some("vault: x"));
        let first = log.prompt().unwrap();
        assert_eq!(
            first,
            format!(
                "{SYSTEM}<|im_start|>user\nvault: x\n\nwhat is due<|im_end|>\n<|im_start|>assistant\n<think>\n"
            )
        );
        log.assistant(&said("intent: read", "find", &[("kind", "task")]));
        log.tool(Some(0), "@1 · 2 tasks");
        let second = log.prompt().unwrap();
        assert!(second.starts_with(&first[..first.len() - assistant_open().len()]));
        assert!(second.contains("<tool_response>\n@1 · 2 tasks\n</tool_response>"));
        assert!(second.ends_with("<|im_start|>assistant\n<think>\n"));
        // thinking is kept in the history
        assert!(second.contains("intent: read"));
    }

    #[test]
    fn a_compaction_replaces_the_observation_it_names_in_place() {
        let mut log = Log::new(SYSTEM.to_owned());
        log.user("a", None);
        log.assistant(&said("t", "find", &[("kind", "task")]));
        log.tool(Some(3), "long result");
        log.tool(Some(4), "other");
        log.compact(&serde_json::json!([{"obs": 3, "text": "@1 · tasks (compacted)"}]));
        let prompt = log.prompt().unwrap();
        assert!(prompt.contains("@1 · tasks (compacted)"));
        assert!(!prompt.contains("long result"));
        assert!(prompt.contains("other"));
    }

    #[test]
    fn an_unreadable_message_is_spliced_in_as_it_was_said_and_the_rest_is_rendered_around_it() {
        let mut log = Log::new(SYSTEM.to_owned());
        log.user("a", None);
        log.assistant("<think>\nhm</think>\n\nI do not know.");
        log.tool(Some(0), "error: could not read the call");
        log.assistant(&said("t", "decline", &[("reason", "out_of_scope")]));
        let prompt = log.prompt().unwrap();
        let spliced = "<|im_start|>assistant\n<think>\nhm</think>\n\nI do not know.<|im_end|>\n";
        assert!(prompt.contains(spliced), "{prompt}");
        // the observation after it opens its own user turn
        assert!(prompt.contains(&format!(
            "{spliced}<|im_start|>user\n<tool_response>\nerror: could not read the call\n</tool_response><|im_end|>\n"
        )));
        assert!(prompt.contains("<function=decline>"));
    }
}
