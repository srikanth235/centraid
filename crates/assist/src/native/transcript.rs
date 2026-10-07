//! THE TRANSCRIPT RENDERER (#1088, R-1088-1): the one text a native session is trained on, scored on, and
//! prompted with. Qwen3.5's token format, except that EVERY assistant message keeps its thinking (Qwen's
//! default chat template drops the thinking of the turns before the last user message; the harness keeps it, so
//! a follow-up sees how the earlier turn was read).
//!
//! The Python side (`experiments/toolchat/native/render.py`) is a client of this module through
//! `nativetools think` (`runtime_think.render`); it carries no renderer of its own. Every special string comes
//! from [`MODEL`] (`identity.rs`); the layout around them (a role name and a newline after `im_start`, a blank line
//! between `think_close` and the call) is written here once.
//!
//! # THE RECORDS
//!
//! A [`Message`] is a record of the shape `render.py` always read:
//!
//! ```text
//! {"role": "system", "content": str, "tools": [<tool dicts>]}
//! {"role": "user", "content": str}                       # user_content(text, block): the runtime's block first
//! {"role": "assistant", "think": str, "tool": str, "args": {name: value}}
//! {"role": "tool", "content": str}                       # the runtime's text, compacted as the harness shows it
//! ```
//!
//! ORDER IS DATA. A call writes its arguments in the order the record lists them, and a tool's JSON schema (and a
//! nested date expression) is written key by key as it came. `serde_json::Value` keeps its maps sorted, so a record
//! is read into [`Json`], which keeps the order of the text it came from; [`parse_messages`] and the
//! `Deserialize` of [`Message`] are the way in.
//!
//! # THE SPANS
//!
//! [`Rendered::spans`] are the loss spans of the trainer: one per assistant message, from just after
//! `<think>\n` through `<|im_end|>`, counted in CODE POINTS (Python `str` indices), which is what
//! `tokens_with_loss` maps through the tokenizer's offsets. [`Rendered::byte_spans`] gives the same spans in
//! bytes of [`Rendered::text`], for a Rust caller that slices it.

use std::fmt::{self, Write as _};

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::native::identity::MODEL;
use crate::native::prompt::call_format;
use crate::native::think::Call;

/// A JSON value that keeps the order of its object keys (Python's `dict`), which `serde_json::Value` does not.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    /// Keys in the order they were written; a repeated key keeps its first place and its last value.
    Object(Vec<(String, Json)>),
}

impl Json {
    /// A string value.
    #[must_use]
    pub fn str(text: &str) -> Self {
        Self::String(text.to_owned())
    }

    /// Python's `json.dumps(value, ensure_ascii=False)`: `", "` and `": "` separators, keys as they came,
    /// non-ASCII kept.
    #[must_use]
    pub fn dumps(&self) -> String {
        let mut out = String::new();
        self.write_dumps(&mut out);
        out
    }

    fn write_dumps(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(true) => out.push_str("true"),
            Self::Bool(false) => out.push_str("false"),
            Self::Number(number) => {
                let _ = write!(out, "{number}");
            }
            Self::String(text) => out.push_str(&quote(text)),
            Self::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    item.write_dumps(out);
                }
                out.push(']');
            }
            Self::Object(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&quote(key));
                    out.push_str(": ");
                    value.write_dumps(out);
                }
                out.push('}');
            }
        }
    }

    /// The text of an argument, as the chat template writes it: a mapping or a sequence as JSON, a boolean as
    /// `true`/`false`, `None` as Python's `str(None)`, a string as it is, a number as its digits.
    #[must_use]
    pub fn arg_text(&self) -> String {
        match self {
            Self::String(text) => text.clone(),
            Self::Array(_) | Self::Object(_) => self.dumps(),
            Self::Bool(true) => "true".to_owned(),
            Self::Bool(false) => "false".to_owned(),
            Self::Null => "None".to_owned(),
            Self::Number(number) => number.to_string(),
        }
    }
}

/// A JSON string literal (what `json.dumps` writes for a `str` with `ensure_ascii=False`).
fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;

        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any JSON value")
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Json, E> {
                Ok(Json::Bool(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Json, E> {
                Ok(Json::Number(v.into()))
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Json, E> {
                Ok(Json::Number(v.into()))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Json, E> {
                serde_json::Number::from_f64(v)
                    .map(Json::Number)
                    .ok_or_else(|| E::custom("a JSON number is finite"))
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Json, E> {
                Ok(Json::String(v.to_owned()))
            }

            fn visit_string<E: de::Error>(self, v: String) -> Result<Json, E> {
                Ok(Json::String(v))
            }

            fn visit_unit<E: de::Error>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }

            fn visit_none<E: de::Error>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }

            fn visit_some<D2: Deserializer<'de>>(self, d: D2) -> Result<Json, D2::Error> {
                Json::deserialize(d)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries: Vec<(String, Json)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    match entries.iter_mut().find(|(have, _)| *have == key) {
                        Some(slot) => slot.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                Ok(Json::Object(entries))
            }
        }

        deserializer.deserialize_any(JsonVisitor)
    }
}

/// One message record.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    /// The system turn; it must come first. `tools` are the schemas of the `<tools>` block, in order.
    System {
        content: String,
        tools: Vec<Json>,
    },
    User {
        content: String,
    },
    /// One assistant step: the think and the one call, `args` in the order the call writes them.
    Assistant {
        think: String,
        tool: String,
        args: Vec<(String, Json)>,
    },
    /// The runtime's observation. Consecutive ones share one user turn.
    Tool {
        content: String,
    },
}

impl Message {
    #[must_use]
    pub fn system(content: &str, tools: Vec<Json>) -> Self {
        Self::System {
            content: content.to_owned(),
            tools,
        }
    }

    #[must_use]
    pub fn user(content: &str) -> Self {
        Self::User {
            content: content.to_owned(),
        }
    }

    /// An assistant record whose arguments are all text, which is what a compiled call has.
    #[must_use]
    pub fn assistant(think: &str, tool: &str, args: &[(&str, &str)]) -> Self {
        Self::Assistant {
            think: think.to_owned(),
            tool: tool.to_owned(),
            args: args
                .iter()
                .map(|(key, value)| ((*key).to_owned(), Json::str(value)))
                .collect(),
        }
    }

    #[must_use]
    pub fn tool(content: &str) -> Self {
        Self::Tool {
            content: content.to_owned(),
        }
    }

    fn role(&self) -> Role {
        match self {
            Self::System { .. } => Role::System,
            Self::User { .. } => Role::User,
            Self::Assistant { .. } => Role::Assistant,
            Self::Tool { .. } => Role::Tool,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// A record as it is written, before its role says which fields it needs.
#[derive(Deserialize)]
struct RawMessage {
    role: String,
    content: Option<String>,
    think: Option<String>,
    tool: Option<String>,
    args: Option<Json>,
    tools: Option<Json>,
}

impl<'de> Deserialize<'de> for Message {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawMessage::deserialize(deserializer)?;
        let need = |field: Option<String>, name: &str| {
            field.ok_or_else(|| de::Error::custom(format!("a {} record has `{name}`", raw.role)))
        };
        match raw.role.as_str() {
            "system" => {
                let tools = match raw.tools {
                    None | Some(Json::Null) => Vec::new(),
                    Some(Json::Array(tools)) => tools,
                    Some(_) => return Err(de::Error::custom("`tools` is a list")),
                };
                Ok(Self::System {
                    content: need(raw.content.clone(), "content")?,
                    tools,
                })
            }
            "user" => Ok(Self::User {
                content: need(raw.content.clone(), "content")?,
            }),
            "tool" => Ok(Self::Tool {
                content: need(raw.content.clone(), "content")?,
            }),
            "assistant" => {
                let args = match raw.args {
                    Some(Json::Object(args)) => args,
                    _ => return Err(de::Error::custom("an assistant record has `args`, a map")),
                };
                Ok(Self::Assistant {
                    think: raw.think.clone().unwrap_or_default(),
                    tool: need(raw.tool.clone(), "tool")?,
                    args,
                })
            }
            other => Err(de::Error::custom(format!("unknown role {other}"))),
        }
    }
}

/// What rendering refuses.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TranscriptError {
    #[error("system message must come first")]
    SystemNotFirst,
    #[error("the records are not a transcript: {0}")]
    Records(String),
}

/// A rendered transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub text: String,
    /// The trained region of each assistant message, in code points of `text`: `[start, end)`.
    pub spans: Vec<(usize, usize)>,
}

impl Rendered {
    /// The same spans as byte offsets into `text`.
    #[must_use]
    pub fn byte_spans(&self) -> Vec<(usize, usize)> {
        let mut at: Vec<usize> = self.text.char_indices().map(|(byte, _)| byte).collect();
        at.push(self.text.len());
        self.spans
            .iter()
            .map(|(start, end)| (at[*start], at[*end]))
            .collect()
    }
}

/// `[Message]` from the JSON text of a list of records, keeping the order of every map.
///
/// # Errors
/// [`TranscriptError::Records`] when the text is not a list of records.
pub fn parse_messages(json: &str) -> Result<Vec<Message>, TranscriptError> {
    serde_json::from_str(json).map_err(|error| TranscriptError::Records(error.to_string()))
}

/// Python's `str.strip()`: Unicode whitespace, which includes the four separators U+001C to U+001F that Rust's
/// `char::is_whitespace` leaves out.
#[must_use]
pub fn py_strip(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// What the template writes after the assistant header: the harness's header opens the thinking too.
#[must_use]
pub fn assistant_header() -> String {
    format!("{}assistant\n", MODEL.im_start)
}

/// `<|im_start|>assistant\n<think>\n`, which opens every trained region and ends every generation prompt.
#[must_use]
pub fn assistant_open() -> String {
    format!("{}{}", assistant_header(), MODEL.think_open)
}

/// One native tool call, exactly as the template writes it (the runtime's `parse_call` reads it back).
#[must_use]
pub fn call_text(tool: &str, args: &[(String, Json)]) -> String {
    let mut out = format!("{}\n{}{tool}>\n", MODEL.tool_call_open, MODEL.function_open);
    for (key, value) in args {
        let _ = write!(
            out,
            "{}{key}>\n{}\n{}\n",
            MODEL.parameter_open,
            value.arg_text(),
            MODEL.parameter_close
        );
    }
    let _ = write!(out, "{}\n{}", MODEL.function_close, MODEL.tool_call_close);
    out
}

/// [`call_text`] of a compiled [`Call`] (its arguments are text).
#[must_use]
pub fn call_text_of(call: &Call) -> String {
    let args: Vec<(String, Json)> = call
        .args
        .iter()
        .map(|(key, value)| (key.clone(), Json::String(value.clone())))
        .collect();
    call_text(&call.tool, &args)
}

/// A user turn's content as the harness writes it (SPEC §6.1): the runtime's block (its `vault:`, `focus:` and
/// `dates:` lines), a blank line, then the message. A missing or empty block is the message alone.
#[must_use]
pub fn user_content(text: &str, preground: Option<&str>) -> String {
    match preground {
        Some(block) if !block.is_empty() => format!("{block}\n\n{text}"),
        _ => text.to_owned(),
    }
}

/// The system block the template writes: the `<tools>` list (when there are tools) and the system text.
fn system_block(content: &str, tools: &[Json]) -> String {
    let content = py_strip(content);
    if tools.is_empty() {
        return format!("{}system\n{content}{}\n", MODEL.im_start, MODEL.im_end);
    }
    let mut out = format!(
        "{}system\n# Tools\n\nYou have access to the following functions:\n\n{}",
        MODEL.im_start, MODEL.tools_open
    );
    for tool in tools {
        out.push('\n');
        out.push_str(&tool.dumps());
    }
    out.push('\n');
    out.push_str(MODEL.tools_close);
    out.push_str("\n\n");
    out.push_str(&call_format());
    if !content.is_empty() {
        out.push_str("\n\n");
        out.push_str(content);
    }
    let _ = writeln!(out, "{}", MODEL.im_end);
    out
}

/// The assistant message from just after `<think>\n`: the think, `</think>`, a blank line, the call, `<|im_end|>`.
fn assistant_body(think: &str, tool: &str, args: &[(String, Json)]) -> String {
    format!(
        "{}\n{}\n\n{}{}",
        py_strip(think),
        MODEL.think_close,
        call_text(tool, args),
        MODEL.im_end
    )
}

/// The transcript text and the loss spans of every assistant message.
///
/// # Errors
/// [`TranscriptError::SystemNotFirst`] when a system message is not the first record.
pub fn render(messages: &[Message]) -> Result<Rendered, TranscriptError> {
    /// The text so far and its length in code points.
    #[derive(Default)]
    struct Out {
        text: String,
        chars: usize,
    }
    impl Out {
        fn put(&mut self, piece: &str) {
            self.text.push_str(piece);
            self.chars += piece.chars().count();
        }
    }
    let mut out = Out::default();
    let mut spans = Vec::new();
    let open = assistant_open();
    let mut previous: Option<Role> = None;
    for (index, message) in messages.iter().enumerate() {
        match message {
            Message::System { content, tools } => {
                if index != 0 {
                    return Err(TranscriptError::SystemNotFirst);
                }
                out.put(&system_block(content, tools));
            }
            Message::User { content } => {
                out.put(&format!(
                    "{}user\n{}{}\n",
                    MODEL.im_start,
                    py_strip(content),
                    MODEL.im_end
                ));
            }
            Message::Assistant { think, tool, args } => {
                out.put(&open);
                let body = assistant_body(think, tool, args);
                let start = out.chars;
                out.put(&body);
                spans.push((start, out.chars));
                out.put("\n");
            }
            Message::Tool { content } => {
                if previous != Some(Role::Tool) {
                    out.put(&format!("{}user", MODEL.im_start));
                }
                out.put(&format!(
                    "\n{}\n{}\n{}",
                    MODEL.tool_response_open,
                    py_strip(content),
                    MODEL.tool_response_close
                ));
                if messages.get(index + 1).map(Message::role) != Some(Role::Tool) {
                    out.put(&format!("{}\n", MODEL.im_end));
                }
            }
        }
        previous = Some(message.role());
    }
    Ok(Rendered {
        text: out.text,
        spans,
    })
}

/// The history (thinking kept) followed by `<|im_start|>assistant\n<think>\n`: what a model is asked to continue.
///
/// # Errors
/// As [`render`].
pub fn render_prompt_for_generation(messages: &[Message]) -> Result<String, TranscriptError> {
    let mut text = render(messages)?.text;
    text.push_str(&assistant_open());
    Ok(text)
}

// ---------------------------------------------------------------------------------------------
// the line protocol (`nativetools think`, op `render`)
// ---------------------------------------------------------------------------------------------

/// The op of a request line, whatever else it holds.
#[derive(Deserialize)]
struct Op {
    op: Option<String>,
}

/// The op of a request line. The Python client writes `{"op":"…",…` compactly, so the name is read off the front of the
/// line; any other spelling of the same JSON takes the slow way, a parse.
fn op_of(line: &str) -> Option<std::borrow::Cow<'_, str>> {
    if let Some(rest) = line.strip_prefix("{\"op\":\"")
        && let Some(end) = rest.find('"')
        && !rest[..end].contains('\\')
    {
        return Some(std::borrow::Cow::Borrowed(&rest[..end]));
    }
    serde_json::from_str::<Op>(line)
        .ok()?
        .op
        .map(std::borrow::Cow::Owned)
}

/// One answer for a transcript request line, or `None` when the line is another op's.
///
/// `{"op":"render","messages":[<records>]}` answers `{"text":…,"spans":[[start,end],…]}`;
/// `{"op":"prompt","messages":[…]}` answers `{"prompt":<the text + the generation header>}`;
/// `{"op":"render_many","conversations":[[<records>],…]}` answers `{"renders":[<one render answer each>]}`. A refusal
/// is `{"error":…}`. `{"op":"call_text","tool":…,"args":{…}}` answers `{"text":<the call as the template writes it>}`
/// and `{"op":"user_content","text":…,"block":<the runtime's block or null>}` answers `{"text":<the user turn's content>}`.
/// The records are read with their map order kept ([`Json`]).
#[must_use]
pub fn answer_line(line: &str) -> Option<String> {
    let op = op_of(line)?;
    match &*op {
        "render" | "prompt" => {
            #[derive(Deserialize)]
            struct One {
                messages: Vec<Message>,
            }
            Some(match serde_json::from_str::<One>(line) {
                Ok(one) if &*op == "render" => answer_render(&one.messages),
                Ok(one) => answer_prompt(&one.messages),
                Err(error) => error_line(&format!("{op}: {error}")),
            })
        }
        "render_many" => {
            #[derive(Deserialize)]
            struct Many {
                conversations: Vec<Vec<Message>>,
            }
            Some(match serde_json::from_str::<Many>(line) {
                Ok(many) => {
                    let renders: Vec<String> = many
                        .conversations
                        .iter()
                        .map(|messages| answer_render(messages))
                        .collect();
                    format!("{{\"renders\":[{}]}}", renders.join(","))
                }
                Err(error) => error_line(&format!("render_many: {error}")),
            })
        }
        "call_text" => {
            #[derive(Deserialize)]
            struct Call {
                tool: String,
                args: Json,
            }
            Some(match serde_json::from_str::<Call>(line) {
                Ok(Call {
                    tool,
                    args: Json::Object(args),
                }) => json!({ "text": call_text(&tool, &args) }).to_string(),
                Ok(_) => error_line("call_text: `args` is a map"),
                Err(error) => error_line(&format!("call_text: {error}")),
            })
        }
        "user_content" => {
            #[derive(Deserialize)]
            struct User {
                text: String,
                block: Option<String>,
            }
            Some(match serde_json::from_str::<User>(line) {
                Ok(user) => {
                    json!({ "text": user_content(&user.text, user.block.as_deref()) }).to_string()
                }
                Err(error) => error_line(&format!("user_content: {error}")),
            })
        }
        _ => None,
    }
}

fn error_line(message: &str) -> String {
    json!({ "error": message }).to_string()
}

fn answer_render(messages: &[Message]) -> String {
    #[derive(Serialize)]
    struct Answer<'a> {
        text: &'a str,
        spans: &'a [(usize, usize)],
    }
    match render(messages) {
        Ok(rendered) => serde_json::to_string(&Answer {
            text: &rendered.text,
            spans: &rendered.spans,
        })
        .unwrap_or_else(|error| error_line(&error.to_string())),
        Err(error) => error_line(&error.to_string()),
    }
}

fn answer_prompt(messages: &[Message]) -> String {
    match render_prompt_for_generation(messages) {
        Ok(prompt) => json!({ "prompt": prompt }).to_string(),
        Err(error) => error_line(&error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_is_pythons_not_rusts() {
        // U+001C..U+001F are whitespace to `str.strip()` and not to `char::is_whitespace`
        assert_eq!(py_strip("\u{1c}\u{1f} a b \u{85}\u{a0}\u{3000}\n"), "a b");
        assert_eq!(py_strip("\u{200b}x"), "\u{200b}x");
        assert_eq!(py_strip(""), "");
    }

    #[test]
    fn a_record_keeps_the_order_of_its_arguments_and_of_a_nested_map() {
        let line = r#"[{"role":"assistant","think":"t","tool":"find","args":{"z":"1","a":{"unit":"day","rel":1,"name":"é"},"m":[1,true,null,"x"],"b":false}}]"#;
        let messages = parse_messages(line).unwrap();
        let Message::Assistant { args, .. } = &messages[0] else {
            panic!("an assistant record")
        };
        assert_eq!(
            args.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
            ["z", "a", "m", "b"]
        );
        assert_eq!(
            call_text("find", args),
            "<tool_call>\n<function=find>\n<parameter=z>\n1\n</parameter>\n\
<parameter=a>\n{\"unit\": \"day\", \"rel\": 1, \"name\": \"é\"}\n</parameter>\n\
<parameter=m>\n[1, true, null, \"x\"]\n</parameter>\n<parameter=b>\nfalse\n</parameter>\n</function>\n</tool_call>"
        );
    }

    #[test]
    fn a_repeated_key_keeps_its_first_place_and_its_last_value() {
        let Json::Object(entries) = serde_json::from_str::<Json>(r#"{"a":1,"b":2,"a":3}"#).unwrap()
        else {
            panic!("an object")
        };
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], ("a".to_owned(), Json::Number(3.into())));
    }

    #[test]
    fn a_system_message_comes_first_and_a_role_is_known() {
        let late = [Message::user("hi"), Message::system("s", Vec::new())];
        assert_eq!(render(&late), Err(TranscriptError::SystemNotFirst));
        assert!(parse_messages(r#"[{"role":"narrator","content":"x"}]"#).is_err());
        assert!(parse_messages(r#"[{"role":"user"}]"#).is_err());
        assert!(parse_messages(r#"[{"role":"assistant","tool":"a","args":[]}]"#).is_err());
    }

    #[test]
    fn a_run_of_tool_turns_is_one_user_turn() {
        let text = render(&[
            Message::tool(" a "),
            Message::tool("b"),
            Message::assistant("t", "answer", &[]),
            Message::tool("c"),
        ])
        .unwrap()
        .text;
        assert_eq!(
            text,
            "<|im_start|>user\n<tool_response>\na\n</tool_response>\n<tool_response>\nb\n</tool_response><|im_end|>\n\
<|im_start|>assistant\n<think>\nt\n</think>\n\n<tool_call>\n<function=answer>\n</function>\n</tool_call><|im_end|>\n\
<|im_start|>user\n<tool_response>\nc\n</tool_response><|im_end|>\n"
        );
    }

    #[test]
    fn user_content_puts_the_block_first() {
        assert_eq!(user_content("hi", Some("vault: x")), "vault: x\n\nhi");
        assert_eq!(user_content("hi", Some("")), "hi");
        assert_eq!(user_content("hi", None), "hi");
    }

    #[test]
    fn a_compiled_call_is_written_as_text() {
        let call = Call {
            tool: "act".to_owned(),
            args: vec![("verb".to_owned(), "star".to_owned())],
        };
        assert_eq!(
            call_text_of(&call),
            call_text("act", &[("verb".to_owned(), Json::str("star"))])
        );
    }
}
