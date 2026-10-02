//! THE PROMPT: Qwen's ChatML, assembled inside a fixed token budget.
//!
//! A turn is two generations, and so two prompts that share a prefix:
//!
//! 1. **Route** — system prompt and tool list, the last two turns, the
//!    question. The model answers with a call (or `none`, or a direct answer).
//! 2. **Phrase** — the route prompt, the call it chose, and the read's digest
//!    as a `<tool_response>` message. The model answers with one sentence.
//!
//! # THE BUDGET
//!
//! The route and phrase prompts plan inside 2048 tokens: system prompt, the
//! tool list (the scoped app's first), one read's digest and the last two
//! turns — and room for the answer. The engine's context is 4096 ([`Budget::context`]):
//! the other half is for a turn with an attachment ([`crate::attach`]), which
//! is the only prompt that can use it, and it never routes.
//! Nothing here can count real tokens (the tokenizer is the engine's), so
//! [`estimate_tokens`] is a deliberately pessimistic character count; the
//! plane stays under the window even when the estimate is generous, and the
//! engine's own count is what [`crate::model::ModelError::ContextExceeded`]
//! reports if the two ever disagree.
//!
//! The budget gives way in a fixed order, so a long conversation degrades the
//! same way every time: older turns first, then tools from the end of the list
//! (never the scoped app's), and for the phrase prompt the digest's rows.
//!
//! # ONE RENDERER FOR TRAINING, EVAL AND THE PHONE
//!
//! [`route_prompt`] is what `contracts/assist/eval-cases.json` is exported
//! through (`crate::eval::export_jsonl`), so the fine-tune trains on the bytes
//! the phone sends. A second renderer would be a second thing to drift.

use crate::call::ToolCall;
use crate::result::ToolOutput;
use crate::tool::{App, ToolSet};

/// How many earlier turns ride in the prompt.
pub const HISTORY_TURNS: usize = 2;

/// The longest question the plane reads, in characters.
pub const USER_MAX: usize = 400;

/// The end-of-turn marker the engine stops on.
pub const END_OF_TURN: &str = "<|im_end|>";

/// How much the prompt coaches the model.
///
/// **One switch, two audiences.** A stock 0.8B model needs to be told the
/// routing rules and shown a few worked routes, and pays for that in prompt
/// tokens on every turn. A model fine-tuned on this crate's export
/// (`assist-eval --export-jsonl`) has the routes in its weights, and the same
/// coaching is dead weight to it — and a distribution shift, if it was
/// trained without it. The style is the one place that decides, so the phone
/// and the fine-tune's training data cannot disagree about which they use:
/// both go through [`route_prompt`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PromptStyle {
    /// The rules, the examples and the tool hints. The default until a
    /// fine-tuned model ships.
    #[default]
    Stock,
    /// The compact prompt a fine-tuned model is trained on: the persona, the
    /// tool list and the reply format, and nothing that coaches.
    FineTuned,
}

impl PromptStyle {
    /// What a phone sends today.
    pub const DEFAULT: Self = Self::Stock;

    /// The name the command line spells it with.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Stock => "stock",
            Self::FineTuned => "fine-tuned",
        }
    }

    /// The style a command line named.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        [Self::Stock, Self::FineTuned]
            .into_iter()
            .find(|style| style.name() == name)
    }
}

/// The context window, what is held back from it, and the prompt's style.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    /// What the route and phrase prompts plan inside, in tokens. Smaller than
    /// [`Self::context`] on purpose: a routing prompt that grew with the
    /// window would be a slower prefill on every question for no better route.
    pub window: u32,
    /// Held back for the model's own output.
    pub reserve: u32,
    /// The engine's context size, in tokens: what a turn with an attachment
    /// may use ([`Self::attach_limit`]).
    pub context: u32,
    /// How much the prompt coaches the model.
    pub style: PromptStyle,
}

impl Budget {
    /// Route and phrase inside 2048 tokens (128 of them for the answer) of a
    /// 4096-token context, in the default style.
    pub const DEFAULT: Self = Self {
        window: 2048,
        reserve: 128,
        context: 4096,
        style: PromptStyle::DEFAULT,
    };

    /// This budget with `style`.
    #[must_use]
    pub const fn styled(self, style: PromptStyle) -> Self {
        Self { style, ..self }
    }

    /// What the route prompt may use. It leaves [`PHRASE_HEADROOM`] so that the
    /// phrase prompt — the same prefix, the call and a digest — always fits.
    pub const fn route_limit(self) -> u32 {
        self.window
            .saturating_sub(self.reserve)
            .saturating_sub(PHRASE_HEADROOM)
    }

    pub const fn phrase_limit(self) -> u32 {
        self.window.saturating_sub(self.reserve)
    }

    /// What the prompt of a turn with an attachment may use: the context less
    /// the room its answer is allowed ([`crate::attach::ATTACH_MAX_TOKENS`]).
    pub const fn attach_limit(self) -> u32 {
        self.context
            .saturating_sub(crate::attach::ATTACH_MAX_TOKENS)
    }
}

/// Tokens the phrase step needs beyond the route prompt: the call, the wrapper
/// and a digest.
const PHRASE_HEADROOM: u32 = 400;

/// The fewest tools a squeezed prompt keeps when nothing is scoped.
const TOOL_FLOOR: usize = 4;

/// A token count that does not under-count: each character is weighed by what
/// Qwen3.5's tokenizer does with its kind, in eighths of a token.
///
/// **Not one flat ratio.** English runs near five characters a token, and the
/// plane's own prompts (JSON, signatures, ChatML) near four — but the digest the
/// phrase step reads is names, dates and amounts, and the tokenizer spells
/// every digit as a token of its own, and the space, dash or letter beside it
/// too. Measured against the real tokenizer
/// (`the_token_estimate_never_undercounts_the_real_tokenizer` in `assist-llama`):
///
/// | text | chars per token |
/// |---|---|
/// | English prose | 5.2 |
/// | the plane's route prompts (mean) | 4.0 |
/// | JSON | 3.8 |
/// | Cyrillic, accented Latin, Arabic | 4.0–4.9 |
/// | URLs | 2.3 |
/// | amounts and CJK | 2.0 |
/// | punctuation runs | 1.5 |
/// | digits, dates, hex | 1.0 |
/// | emoji | 0.5 |
///
/// so a flat one-per-three-characters count under-counted a column of dates
/// by a factor of three while over-counting prose. The weights below are
/// letters and spaces a quarter token, other ASCII three-quarters, a
/// non-Latin-script letter below U+0800 (Cyrillic, Greek, Arabic) a half, CJK
/// and its kin one and a half, emoji and symbols three, and **anything beside a
/// digit, and a digit, one and an eighth**. Each is at or above the table, plus two for the
/// start of the text. On the plane's own prompts that is about 1.2x the real
/// count — the margin — and the engine's own count stays the backstop
/// ([`crate::model::ModelError::ContextExceeded`]).
#[must_use]
pub fn estimate_tokens(text: &str) -> u32 {
    let chars: Vec<char> = text.chars().collect();
    let eighths: u64 = chars
        .iter()
        .enumerate()
        .map(|(at, &c)| {
            let beside_digit = c.is_ascii_digit()
                || (at > 0 && chars[at - 1].is_ascii_digit())
                || chars.get(at + 1).is_some_and(char::is_ascii_digit);
            let weight: u64 = match c {
                c if c.is_ascii_alphabetic() || c.is_whitespace() => 2,
                c if c.is_ascii() => 6,
                c if c.is_alphabetic() && u32::from(c) < 0x800 => 4,
                c if c.is_alphabetic() => 12,
                _ => 24,
            };
            if beside_digit { weight.max(9) } else { weight }
        })
        .sum();
    u32::try_from(eighths.div_ceil(8) + 2).unwrap_or(u32::MAX)
}

/// What the assistant did on an earlier turn, as far as the next prompt needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    /// It read: the call it made, the read's headline, the sentence it said.
    Tool {
        call_json: String,
        headline: String,
        answer: String,
    },
    /// It answered directly.
    Answer(String),
    /// It said no tool fits.
    NoTool,
    /// It answered over an attachment. **Never shown to the router**: a route
    /// prompt that held a paragraph describing a photograph would be asked to
    /// continue it, and the question after it is about the vault. The chat and
    /// attachment prompts show it, under the turn's marker line.
    Attachment(String),
}

/// One earlier turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub user: String,
    pub record: Recorded,
}

impl Turn {
    /// The turn as the vault keeps it beside the answer it belongs to, so a
    /// reopened chat's follow-up is routed the way it would have been had the
    /// app never closed: the read the assistant made and the headline it was
    /// handed are what the next prompt shows, and neither is in the words a
    /// member read.
    #[must_use]
    pub fn to_json(&self) -> String {
        let record = match &self.record {
            Recorded::Tool {
                call_json,
                headline,
                answer,
            } => serde_json::json!({
                "kind": "tool", "call_json": call_json, "headline": headline, "answer": answer
            }),
            Recorded::Answer(text) => serde_json::json!({ "kind": "answer", "text": text }),
            Recorded::NoTool => serde_json::json!({ "kind": "no_tool" }),
            Recorded::Attachment(text) => {
                serde_json::json!({ "kind": "attachment", "text": text })
            }
        };
        serde_json::json!({ "user": self.user, "record": record }).to_string()
    }

    /// A turn read back from [`Self::to_json`]. `None` for text that is not
    /// one: a record this build cannot read is no history, never a guess.
    #[must_use]
    pub fn from_json(text: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let user = value.get("user")?.as_str()?.to_owned();
        let record = value.get("record")?;
        let field = |key: &str| record.get(key).and_then(serde_json::Value::as_str);
        let record = match field("kind")? {
            "tool" => Recorded::Tool {
                call_json: field("call_json")?.to_owned(),
                headline: field("headline")?.to_owned(),
                answer: field("answer")?.to_owned(),
            },
            "answer" => Recorded::Answer(field("text")?.to_owned()),
            "no_tool" => Recorded::NoTool,
            "attachment" => Recorded::Attachment(field("text")?.to_owned()),
            _ => return None,
        };
        Some(Self { user, record })
    }
}

/// The routing prompt, and the tools it offered after the budget had its say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutePrompt {
    pub text: String,
    /// The tools actually listed. The grammar is generated from these.
    pub tools: ToolSet,
    pub tokens: u32,
    /// The question as the prompt holds it, which the phrase step is asked
    /// again.
    pub question: String,
}

/// The phrasing prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhrasePrompt {
    pub text: String,
    pub tokens: u32,
}

pub(crate) fn message(role: &str, content: &str) -> String {
    format!("<|im_start|>{role}\n{content}{END_OF_TURN}\n")
}

/// WHERE THE MODEL BEGINS: the assistant's turn, opened with an EMPTY thinking
/// block.
///
/// Qwen3.5's own chat template ends its generation prompt this way when
/// thinking is off (`enable_thinking` unset), and its models are trained to
/// answer after `</think>`. Without the block a Qwen3.5 opens `<think>` itself
/// and spends the token ceiling reasoning before it says `{`; and under the
/// route grammar, which allows nothing but a route, it cannot open it at all
/// and is pushed into an off-distribution first token. The block is part of
/// the prompt, not of the output, so the grammar starts at the answer.
pub const ASSISTANT_TURN: &str = "<|im_start|>assistant\n<think>\n\n</think>\n\n";

fn tool_response(digest: &str) -> String {
    message(
        "user",
        &format!("<tool_response>\n{digest}\n</tool_response>"),
    )
}

/// THE RULES a stock model is given: what must read, what may refuse.
///
/// The stock Qwen3.5-0.8B's dominant failure was `{"tool":"none"}` on a plain
/// question about the member's own data, and once one route is `none` it copies
/// `none` down the history. These lines say what `none` is *for*, so that it
/// stops being the safe-looking default.
///
/// **They never spell a route's JSON.** A first draft did, and the model read
/// the literal `{"tool":"none"}` as the thing to say: 12 of 65 routes exact,
/// against 19 with no rules at all. Words here, spellings in [`EXAMPLES`].
const RULES: [&str; 5] = [
    "Any question about the member's own tasks, notes, documents, calendar, people, photos or expenses needs a tool. Pick the tool of the app the question is about.",
    "When the question names a person, place, thing or topic, use that app's search tool with it as the term.",
    "Leave out optional arguments the question does not ask for.",
    "Answer none only when the request is to add, change or delete something, or is not about the member's data at all.",
    "Answer directly only for a greeting or a question about what you can do.",
];

/// WORKED ROUTES shown to a stock model: a question, then the route's one
/// canonical spelling.
///
/// **They are not the eval set, and a test holds them apart**
/// (`tests::no_example_is_an_eval_question_or_close_to_one`): an example that
/// paraphrased `contracts/assist/eval-cases.json` would turn the accuracy
/// number into a measure of the prompt's memory and not of the model. They are
/// over content the sample vault does not hold (a garage sale, a plumber, a
/// school concert) and between them show a term argument, a choice argument, a
/// refusal for a write, a refusal for a topic outside the vault and a direct
/// reply.
///
/// Placed in the system message they beat the same pairs as earlier chat turns
/// (31 against 20 routes exact, measured): as turns they read as history, which
/// a small model copies from rather than learns from.
pub const EXAMPLES: [(&str, &str); 7] = [
    (
        "Did I jot anything down about the garage sale?",
        r#"{"tool":"notes.search","args":{"term":"garage sale"}}"#,
    ),
    (
        "What time is the school concert?",
        r#"{"tool":"agenda.search","args":{"term":"school concert"}}"#,
    ),
    (
        "Which tasks have no date on them?",
        r#"{"tool":"tasks.list","args":{"view":"anytime"}}"#,
    ),
    (
        "What did the plumber charge us?",
        r#"{"tool":"tally.search","args":{"term":"plumber"}}"#,
    ),
    ("Move my meeting to Thursday", r#"{"tool":"none"}"#),
    ("Who wrote Moby Dick?", r#"{"tool":"none"}"#),
    ("Thanks!", r#"{"answer":"You're welcome."}"#),
];

/// The system prompt, listing exactly the tools the grammar will allow.
///
/// [`PromptStyle::FineTuned`] is the compact prompt: the persona, each tool's
/// signature and label, and the reply format. [`PromptStyle::Stock`] adds what
/// a model that has not been trained on this registry has to be told — each
/// tool's longer hint, the rules, the worked routes — and a reply line that
/// leaves the three route forms to the examples (the longer spelling-out of
/// `none` and `answer` made a stock model say `none` more often).
#[must_use]
pub fn system_prompt(tools: &ToolSet, style: PromptStyle) -> String {
    let stock = style == PromptStyle::Stock;
    let mut lines = vec![
        "You are the assistant inside Centraid, a personal app on the member's phone. \
         Read their data with one tool, or answer directly when no data is needed. Never invent data."
            .to_owned(),
        "Tools:".to_owned(),
    ];
    lines.extend(tools.iter().map(|spec| {
        let words = if stock { spec.hint } else { spec.doc };
        format!("- {}: {words}", spec.signature())
    }));
    if stock {
        lines.push("Rules:".to_owned());
        lines.extend(RULES.iter().map(|rule| format!("- {rule}")));
        lines.push("Examples:".to_owned());
        lines.extend(
            EXAMPLES
                .iter()
                .map(|(asked, route)| format!("Q: {asked}\nA: {route}")),
        );
        lines.push(
            "Reply with one JSON object only. After a tool result, reply with one short plain sentence about it."
                .to_owned(),
        );
    } else {
        lines.push(
            r#"Reply with JSON only: {"tool":NAME,"args":{...}} to read, {"tool":"none"} when no tool fits, or {"answer":TEXT} for a short direct reply. After a tool result, reply with one short plain sentence about it."#
                .to_owned(),
        );
    }
    lines.join("\n")
}

fn render_history(turns: &[&Turn]) -> String {
    let mut out = String::new();
    for turn in turns {
        out.push_str(&message("user", &turn.user));
        match &turn.record {
            Recorded::Tool {
                call_json,
                headline,
                answer,
            } => {
                out.push_str(&message("assistant", call_json));
                out.push_str(&tool_response(headline));
                out.push_str(&message("assistant", answer));
            }
            Recorded::Answer(text) => {
                out.push_str(&message(
                    "assistant",
                    &format!("{{\"answer\":{}}}", json_string(text)),
                ));
            }
            // Never rendered: `route_prompt` filters refusals and attachment
            // turns out. Spelled for completeness, in the route's own words.
            Recorded::NoTool | Recorded::Attachment(_) => {
                out.push_str(&message("assistant", "{\"tool\":\"none\"}"));
            }
        }
    }
    out
}

fn json_string(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

/// The question as the prompt holds it: one line, at most [`USER_MAX`] characters.
#[must_use]
pub fn question(text: &str) -> String {
    crate::call::normalize(text)
        .chars()
        .take(USER_MAX)
        .collect()
}

fn render_route(tools: &ToolSet, style: PromptStyle, history: &[&Turn], user: &str) -> String {
    format!(
        "{}{}{}{ASSISTANT_TURN}",
        message("system", &system_prompt(tools, style)),
        render_history(history),
        message("user", user),
    )
}

/// Assemble the routing prompt for `user` under `budget`.
///
/// `history` is every earlier turn. **A refusal is not shown**: a turn the
/// model answered `none` is dropped before the last [`HISTORY_TURNS`] are
/// taken, so one refusal cannot be copied down the chat — a 0.8B model that
/// sees `{"tool":"none"}` as its own last words says it again. The turns shown
/// are the last [`HISTORY_TURNS`] that read or answered.
#[must_use]
pub fn route_prompt(
    scope: Option<App>,
    history: &[Turn],
    user: &str,
    budget: Budget,
) -> RoutePrompt {
    let user = question(user);
    let mut tools = ToolSet::for_scope(scope);
    let shown: Vec<&Turn> = history
        .iter()
        .filter(|turn| !matches!(turn.record, Recorded::NoTool | Recorded::Attachment(_)))
        .collect();
    let mut history = &shown[shown.len().saturating_sub(HISTORY_TURNS)..];
    let floor = scope.map_or(TOOL_FLOOR, |app| {
        tools
            .iter()
            .filter(|spec| spec.app == app)
            .count()
            .max(TOOL_FLOOR)
    });
    loop {
        let text = render_route(&tools, budget.style, history, &user);
        let tokens = estimate_tokens(&text);
        if tokens <= budget.route_limit() {
            return RoutePrompt {
                text,
                tools,
                tokens,
                question: user,
            };
        }
        if let Some((_, rest)) = history.split_first() {
            history = rest;
        } else if !tools.drop_last(floor) {
            // Nothing left to give: the question and the floor are what they are.
            return RoutePrompt {
                text,
                tools,
                tokens,
                question: user,
            };
        }
    }
}

/// FREE CHAT: what the model is told when no tool fits.
///
/// A question no read answers ("hi", "what can you do?") gets a short,
/// unconstrained reply streamed token by token, rather than a refusal. It reads
/// nothing, so it can only talk; it is told so, and told never to invent rows.
const CHAT_SYSTEM: &str = "You are Centraid, a private assistant that runs entirely on the member's phone. Their vault holds tasks, notes, documents, calendar events, people, photos and expenses. Reply in a few short, friendly sentences. You have not looked at their vault for this reply, so never state facts about their data; suggest a question about one of those apps instead.";

/// The free-chat prompt: [`CHAT_SYSTEM`], the last [`HISTORY_TURNS`] turns
/// that said something, and the question, opened at [`ASSISTANT_TURN`].
#[must_use]
pub fn chat_prompt(history: &[Turn], user: &str) -> String {
    let shown: Vec<&Turn> = history
        .iter()
        .filter(|turn| turn.record != Recorded::NoTool)
        .collect();
    let mut out = message("system", CHAT_SYSTEM);
    for turn in &shown[shown.len().saturating_sub(HISTORY_TURNS)..] {
        out.push_str(&message("user", &turn.user));
        let said = match &turn.record {
            Recorded::Tool { answer, .. } => answer.as_str(),
            Recorded::Answer(text) | Recorded::Attachment(text) => text.as_str(),
            Recorded::NoTool => continue,
        };
        out.push_str(&message("assistant", said));
    }
    out.push_str(&message("user", &question(user)));
    out.push_str(ASSISTANT_TURN);
    out
}

/// The phrase step's instructions to a stock model.
///
/// A stock model handed the route conversation plus a `<tool_response>`
/// re-emitted route JSON nine times in ten (the conversation it continues is
/// all JSON), and forbidding a leading `{` in the grammar alone produced
/// fluent but empty or wrong-voiced lines ("I owe you money"). So the stock
/// phrase prompt is not a continuation: it is its own short conversation whose
/// only job is one sentence, spoken to the member, from the result.
const PHRASE_SYSTEM: &str = "You reply to the member of a personal app with one short, plain sentence that answers their question from the result. Speak to them as \"you\". Use only the facts and numbers in the result, and never add numbers up. No JSON, no lists, no quotes, and never mention tools, data or results.";

/// Two worked replies, over content the sample vault does not hold; the first
/// shows a count that names its items, the second a figure. A test holds them
/// apart from the eval set too.
pub const PHRASE_EXAMPLES: [(&str, &str, &str); 2] = [
    (
        "Which errands are left?",
        "2 tasks left\n1. Post the parcel | 2026-03-02\n2. Buy stamps | 2026-03-03",
        "You have two errands left: posting the parcel and buying stamps.",
    ),
    (
        "What was the electricity bill?",
        "1 expense matching \"electricity\"\n1. Electricity bill | 84.20 USD | 2026-02-11",
        "The electricity bill was 84.20 USD.",
    ),
];

/// The user message that asks for the sentence: the question, the digest and
/// the one instruction nearest the model's turn.
fn phrase_request(question: &str, digest: &str) -> String {
    format!("Question: {question}\nResult:\n{digest}\nReply in one short plain sentence.")
}

/// The system message of a stock phrase prompt: the instruction and its examples.
fn phrase_system() -> String {
    let mut text = PHRASE_SYSTEM.to_owned();
    for (asked, digest, reply) in PHRASE_EXAMPLES {
        text.push_str(&format!(
            "\nExample:\nQuestion: {asked}\nResult:\n{digest}\nReply: {reply}"
        ));
    }
    text
}

/// Assemble the phrasing prompt for a read's `output`.
///
/// [`PromptStyle::Stock`] gets a short conversation of its own (instruction,
/// examples, the question and the digest), which costs a fifth of the route
/// prompt's tokens to read. [`PromptStyle::FineTuned`] gets what a model
/// trained on the route conversation expects: that conversation continued —
/// the route prompt, the call it chose, the digest as a `<tool_response>`.
#[must_use]
pub fn phrase_prompt(
    route: &RoutePrompt,
    call: &ToolCall,
    output: &ToolOutput,
    budget: Budget,
) -> PhrasePrompt {
    // The route prompt ends where the model began, so the call is the
    // model's own turn continuing it (the turn being answered keeps its empty
    // thinking block; earlier turns in `render_history` do not).
    let head = format!("{}{}{END_OF_TURN}\n", route.text, call.to_json());
    let system = message("system", &phrase_system());
    for (rows, chars) in [(5, 700), (3, 450), (1, 250), (0, 160)] {
        let digest = output.digest(rows, chars);
        let text = match budget.style {
            PromptStyle::Stock => format!(
                "{system}{}{ASSISTANT_TURN}",
                message("user", &phrase_request(&route.question, &digest)),
            ),
            PromptStyle::FineTuned => format!("{head}{}{ASSISTANT_TURN}", tool_response(&digest)),
        };
        let tokens = estimate_tokens(&text);
        if tokens <= budget.phrase_limit() || rows == 0 {
            return PhrasePrompt { text, tokens };
        }
    }
    unreachable!("the last digest size always returns")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::result::Card;
    use crate::tool::{TOOLS, tool};

    fn recorded(n: usize) -> Turn {
        Turn {
            user: format!("question {n}"),
            record: Recorded::Tool {
                call_json: r#"{"tool":"tasks.list","args":{"view":"today"}}"#.to_owned(),
                headline: format!("{n} tasks due today"),
                answer: format!("answer {n}"),
            },
        }
    }

    #[test]
    fn a_route_prompt_is_chatml_ending_where_the_model_begins() {
        let prompt = route_prompt(None, &[], "What is due today?", Budget::DEFAULT);
        assert!(
            prompt
                .text
                .starts_with("<|im_start|>system\nYou are the assistant inside Centraid")
        );
        assert!(
            prompt.text.ends_with(
                "<|im_start|>user\nWhat is due today?<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
            )
        );
        assert!(
            prompt
                .text
                .contains("- tasks.list(view?: today|upcoming|overdue|inbox|anytime|done, project?: text): the to-do list:")
        );
    }

    #[test]
    fn the_fine_tuned_style_is_the_compact_prompt_with_no_coaching() {
        let compact = Budget::DEFAULT.styled(PromptStyle::FineTuned);
        let prompt = route_prompt(None, &[], "What is due today?", compact);
        assert!(prompt.text.contains(
            "- tasks.list(view?: today|upcoming|overdue|inbox|anytime|done, project?: text): tasks by view or project"
        ));
        assert!(
            prompt
                .text
                .contains(r#"Reply with JSON only: {"tool":NAME"#)
        );
        for coaching in ["Rules:", "Examples:", "Q: "] {
            assert!(!prompt.text.contains(coaching), "{coaching}");
        }
        let stock = route_prompt(None, &[], "What is due today?", Budget::DEFAULT);
        assert!(stock.text.contains("Rules:") && stock.text.contains("Examples:"));
        assert!(
            stock.tokens > prompt.tokens + 150,
            "the coaching is what costs tokens: {} against {}",
            stock.tokens,
            prompt.tokens
        );
        assert_eq!(
            Budget::DEFAULT.style,
            PromptStyle::Stock,
            "the phone sends the coached prompt until a fine-tuned model ships"
        );
    }

    #[test]
    fn a_style_has_a_name_the_command_line_can_say() {
        for style in [PromptStyle::Stock, PromptStyle::FineTuned] {
            assert_eq!(PromptStyle::from_name(style.name()), Some(style));
        }
        assert_eq!(PromptStyle::from_name("tuned"), None);
    }

    #[test]
    fn the_rules_say_what_none_is_for_without_spelling_the_route() {
        for rule in RULES {
            assert!(!rule.contains('{') && !rule.contains("\"tool\""), "{rule}");
        }
        let text = RULES.join(" ");
        assert!(text.contains("needs a tool") && text.contains("none only"));
    }

    #[test]
    fn every_tool_is_listed_and_locker_never_is() {
        for style in [PromptStyle::Stock, PromptStyle::FineTuned] {
            let budget = Budget::DEFAULT.styled(style);
            let prompt = route_prompt(None, &[], "hello", budget);
            for spec in TOOLS {
                assert!(
                    prompt.text.contains(&format!("- {}:", spec.signature())),
                    "{}",
                    spec.name
                );
            }
            assert!(!prompt.text.to_lowercase().contains("locker"));
            let phrase = phrase_prompt(
                &prompt,
                &ToolCall::new("people.reconnect", []).unwrap(),
                &ToolOutput::of_rows("1 person", Vec::new()),
                budget,
            );
            assert!(!phrase.text.to_lowercase().contains("locker"));
        }
    }

    #[test]
    fn a_scoped_chat_lists_its_apps_tools_first() {
        let prompt = route_prompt(Some(App::Tally), &[], "hello", Budget::DEFAULT);
        let first = prompt.text.find("- tally.balances").unwrap();
        let other = prompt.text.find("- agenda.upcoming").unwrap();
        assert!(first < other);
    }

    #[test]
    fn only_the_last_two_turns_ride_along() {
        let history: Vec<Turn> = (1..=4).map(recorded).collect();
        let prompt = route_prompt(None, &history, "and tomorrow?", Budget::DEFAULT);
        assert!(!prompt.text.contains("question 2"));
        assert!(prompt.text.contains("question 3"));
        assert!(prompt.text.contains("question 4"));
        assert!(
            prompt
                .text
                .contains("<tool_response>\n4 tasks due today\n</tool_response>")
        );
        assert!(
            prompt
                .text
                .contains("<|im_start|>assistant\nanswer 4<|im_end|>")
        );
    }

    #[test]
    fn a_direct_answer_is_remembered_in_the_routes_own_words_and_a_refusal_is_not_shown() {
        let history = vec![
            Turn {
                user: "hi".to_owned(),
                record: Recorded::Answer("Hello.".to_owned()),
            },
            Turn {
                user: "weather?".to_owned(),
                record: Recorded::NoTool,
            },
        ];
        for style in [PromptStyle::Stock, PromptStyle::FineTuned] {
            let prompt = route_prompt(None, &history, "ok", Budget::DEFAULT.styled(style));
            assert!(prompt.text.contains(r#"{"answer":"Hello."}"#));
            assert!(!prompt.text.contains("weather?"));
            // The only `none` the prompt may hold is the system prompt's own:
            // the stock examples' two, or the compact reply line's one.
            let nones = prompt.text.matches(r#"{"tool":"none"}"#).count();
            assert_eq!(
                nones,
                if style == PromptStyle::Stock { 2 } else { 1 },
                "{style:?}"
            );
        }
    }

    #[test]
    fn a_refusal_does_not_use_up_one_of_the_two_history_slots() {
        // Three turns, the newest two refused: the one that read is still the
        // history, and the chat is not taught `none` by its own last words.
        let history = vec![
            recorded(1),
            Turn {
                user: "refused one".to_owned(),
                record: Recorded::NoTool,
            },
            Turn {
                user: "refused two".to_owned(),
                record: Recorded::NoTool,
            },
        ];
        let prompt = route_prompt(None, &history, "what is due?", Budget::DEFAULT);
        assert!(prompt.text.contains("question 1"));
        assert!(!prompt.text.contains("refused"));

        // And with reads around the refusals, the last two reads are shown.
        let history = vec![
            recorded(1),
            recorded(2),
            Turn {
                user: "refused".to_owned(),
                record: Recorded::NoTool,
            },
            recorded(3),
        ];
        let prompt = route_prompt(None, &history, "and now?", Budget::DEFAULT);
        assert!(!prompt.text.contains("question 1"));
        assert!(prompt.text.contains("question 2") && prompt.text.contains("question 3"));
    }

    #[test]
    fn the_worst_case_fits_the_budget_with_room_for_the_phrase_step() {
        let long = "a long question ".repeat(60);
        let history: Vec<Turn> = (1..=3).map(recorded).collect();
        let route = route_prompt(Some(App::Photos), &history, &long, Budget::DEFAULT);
        assert!(
            route.tokens <= Budget::DEFAULT.route_limit(),
            "{}",
            route.tokens
        );
        assert_eq!(route.tools.len(), TOOLS.len(), "the full list fits at 2K");

        let rows: Vec<Card> = (0..12)
            .map(|n| {
                Card::new(
                    App::Photos,
                    "photo",
                    format!("p{n}"),
                    "A photograph with a fairly long title",
                )
                .subtitle("2026-09-28")
                .meta("Tahoe scouting")
            })
            .collect();
        let output = ToolOutput::of_rows("12 photographs", rows);
        let call = ToolCall::new("photos.recent", []).unwrap();
        let phrase = phrase_prompt(&route, &call, &output, Budget::DEFAULT);
        assert!(
            phrase.tokens <= Budget::DEFAULT.phrase_limit(),
            "{}",
            phrase.tokens
        );
        assert!(phrase.tokens + Budget::DEFAULT.reserve <= Budget::DEFAULT.window);
    }

    #[test]
    fn a_squeezed_budget_drops_old_turns_first_then_tools_from_the_end() {
        let history: Vec<Turn> = (1..=2).map(recorded).collect();
        let tight = Budget {
            window: 950,
            reserve: 100,
            ..Budget::DEFAULT
        };
        let prompt = route_prompt(Some(App::Tally), &history, "hi", tight);
        assert!(
            !prompt.text.contains("question 1"),
            "history goes before tools"
        );
        assert!(prompt.tools.len() < TOOLS.len());
        let names: Vec<&str> = prompt.tools.iter().map(|spec| spec.name).collect();
        for scoped in [
            "tally.balances",
            "tally.recent",
            "tally.search",
            "tally.spending",
        ] {
            assert!(
                names.contains(&scoped),
                "the scoped app's tools survive: {scoped}"
            );
        }
    }

    #[test]
    fn a_budget_nothing_can_meet_still_returns_the_floor_rather_than_looping() {
        let prompt = route_prompt(
            None,
            &[],
            "hi",
            Budget {
                window: 10,
                reserve: 5,
                ..Budget::DEFAULT
            },
        );
        assert_eq!(prompt.tools.len(), TOOL_FLOOR);
    }

    #[test]
    fn a_dropped_tool_is_not_listed() {
        let tight = Budget {
            window: 950,
            reserve: 100,
            ..Budget::DEFAULT
        };
        let prompt = route_prompt(Some(App::Tally), &[], "hi", tight);
        let dropped = TOOLS
            .iter()
            .find(|spec| !prompt.tools.contains(spec.name))
            .unwrap();
        assert!(!prompt.text.contains(&format!("- {}:", dropped.signature())));
    }

    #[test]
    fn the_question_is_one_line_and_capped() {
        let long = format!("a\n\nb {}", "x".repeat(600));
        let asked = question(&long);
        assert!(asked.starts_with("a b xxx"));
        assert_eq!(asked.chars().count(), USER_MAX);
    }

    fn due_today() -> (ToolCall, ToolOutput) {
        (
            ToolCall::new("tasks.list", [("view", "today")]).unwrap(),
            ToolOutput::of_rows(
                "1 task due today",
                vec![
                    Card::new(App::Tasks, "task", "t1", "Pick up the dry cleaning")
                        .subtitle("2026-10-01"),
                ],
            ),
        )
    }

    #[test]
    fn a_stock_phrase_prompt_is_its_own_short_conversation_ending_where_the_model_begins() {
        let route = route_prompt(None, &[], "What is due today?", Budget::DEFAULT);
        let (call, output) = due_today();
        let phrase = phrase_prompt(&route, &call, &output, Budget::DEFAULT);
        assert!(
            phrase
                .text
                .starts_with("<|im_start|>system\nYou reply to the member")
        );
        assert!(phrase.text.ends_with(
            "<|im_start|>user\nQuestion: What is due today?\nResult:\n1 task due today\n1. Pick up the dry cleaning | 2026-10-01\nReply in one short plain sentence.<|im_end|>\n\
             <|im_start|>assistant\n<think>\n\n</think>\n\n"
        ));
        // It is not the route conversation: no tool list, no call, no JSON to copy.
        assert!(!phrase.text.contains("Tools:") && !phrase.text.contains("tasks.list"));
        assert!(!phrase.text.contains("<tool_response>"));
        assert!(
            phrase.tokens * 2 < route.tokens + 100,
            "a fifth of the work, give or take: {} against {}",
            phrase.tokens,
            route.tokens
        );
        for (asked, digest, reply) in PHRASE_EXAMPLES {
            assert!(phrase.text.contains(&format!(
                "Question: {asked}\nResult:\n{digest}\nReply: {reply}"
            )));
        }
    }

    #[test]
    fn a_fine_tuned_phrase_prompt_continues_the_route_prompt_with_the_call_and_the_digest() {
        let budget = Budget::DEFAULT.styled(PromptStyle::FineTuned);
        let route = route_prompt(None, &[], "What is due today?", budget);
        let (call, output) = due_today();
        let phrase = phrase_prompt(&route, &call, &output, budget);
        assert!(phrase.text.starts_with(&route.text));
        assert!(phrase.text.ends_with(
            "<|im_start|>assistant\n<think>\n\n</think>\n\n{\"tool\":\"tasks.list\",\"args\":{\"view\":\"today\"}}<|im_end|>\n\
             <|im_start|>user\n<tool_response>\n1 task due today\n1. Pick up the dry cleaning | 2026-10-01\n</tool_response><|im_end|>\n\
             <|im_start|>assistant\n<think>\n\n</think>\n\n"
        ));
    }

    #[test]
    fn a_squeezed_phrase_prompt_shrinks_the_digest_not_the_instruction() {
        for style in [PromptStyle::Stock, PromptStyle::FineTuned] {
            let budget = Budget::DEFAULT.styled(style);
            let route = route_prompt(None, &[], "x", budget);
            let call = ToolCall::new("tally.recent", []).unwrap();
            let rows: Vec<Card> = (0..9)
                .map(|n| {
                    Card::new(
                        App::Tally,
                        "expense",
                        format!("e{n}"),
                        format!("Expense number {n}"),
                    )
                })
                .collect();
            let output = ToolOutput::of_rows("9 expenses", rows);
            let roomy = phrase_prompt(&route, &call, &output, budget);
            let tight = Budget {
                window: roomy.tokens - 60,
                reserve: 20,
                ..budget
            };
            let squeezed = phrase_prompt(&route, &call, &output, tight);
            assert!(squeezed.text.len() < roomy.text.len(), "{style:?}");
            assert!(
                squeezed.text.contains("9 expenses"),
                "the headline always stays"
            );
            if style == PromptStyle::FineTuned {
                assert!(squeezed.text.starts_with(&route.text));
            }
        }
    }

    #[test]
    fn the_phrase_step_asks_for_the_voice_the_stock_model_kept_missing() {
        // The measured failures, each answered by a clause of the instruction:
        // route JSON again, the member as "the user", a figure that was added up.
        for clause in [
            "one short, plain sentence",
            "Speak to them as \"you\"",
            "never add numbers up",
            "No JSON",
            "never mention tools, data or results",
        ] {
            assert!(PHRASE_SYSTEM.contains(clause), "{clause}");
        }
    }

    #[test]
    fn the_tool_registry_and_the_prompt_agree_on_every_signature() {
        let prompt = route_prompt(None, &[], "x", Budget::DEFAULT);
        assert!(
            prompt
                .text
                .contains(&tool("agenda.upcoming").unwrap().signature())
        );
    }

    // ---- the examples are not the eval set ----

    /// Lower-case words, nothing else: how two questions are compared.
    fn words(text: &str) -> std::collections::BTreeSet<String> {
        text.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect()
    }

    fn normalized(text: &str) -> String {
        words(text).into_iter().collect::<Vec<_>>().join(" ")
    }

    /// Every question the committed fixture asks, its follow-ups' history included.
    fn eval_questions() -> Vec<String> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/assist/eval-cases.json"
        );
        let file = crate::eval::EvalFile::parse(
            &std::fs::read_to_string(path).expect("the fixture is committed"),
        )
        .expect("the committed fixture is valid");
        file.cases
            .iter()
            .flat_map(|case| {
                std::iter::once(case.question.clone())
                    .chain(case.history.iter().map(|entry| entry.user.clone()))
            })
            .collect()
    }

    /// Whether two questions are one question: the same words, or most of them.
    fn same_question(a: &str, b: &str) -> bool {
        let (a, b) = (words(a), words(b));
        let shared = a.intersection(&b).count();
        let union = a.union(&b).count();
        a == b || (union > 0 && shared * 2 >= union)
    }

    #[test]
    fn no_example_is_an_eval_question_or_close_to_one() {
        let eval = eval_questions();
        assert!(eval.len() >= 65, "the fixture was read");
        let asked = EXAMPLES
            .iter()
            .map(|(asked, _)| *asked)
            .chain(PHRASE_EXAMPLES.iter().map(|(asked, _, _)| *asked));
        for example in asked {
            for question in &eval {
                assert_ne!(normalized(example), normalized(question), "{example}");
                assert!(
                    !same_question(example, question),
                    "the example `{example}` is too close to the eval question `{question}`"
                );
            }
        }
    }

    #[test]
    fn the_comparison_catches_a_reworded_eval_question() {
        // The check above must be able to fail: these are the same question.
        assert!(same_question("What's due today?", "what is due today"));
        assert!(same_question("Who owes me money?", "Who owes me money"));
        assert!(!same_question(
            "What time is the school concert?",
            "When is my dentist appointment?"
        ));
    }

    #[test]
    fn the_examples_are_over_content_the_sample_vault_does_not_hold() {
        for (asked, route) in EXAMPLES {
            let line = format!("{asked} {route}").to_lowercase();
            for banned in ["tahoe", "locker", "cabin", "maya", "ana "] {
                assert!(!line.contains(banned), "{asked}: {banned}");
            }
        }
    }

    #[test]
    fn every_example_route_is_one_the_grammar_says_in_its_one_spelling() {
        use crate::call::{Route, parse_route};
        let tools = ToolSet::for_scope(None);
        let grammar = crate::grammar::check::Grammar::parse(&crate::grammar::route_gbnf(&tools));
        let (mut calls, mut nones, mut answers) = (0, 0, 0);
        for (asked, route) in EXAMPLES {
            assert!(grammar.accepts(route), "{asked}: {route}");
            match parse_route(route, &tools).expect("a route") {
                Route::Tool(call) => {
                    assert_eq!(call.to_json(), route, "{asked}: the canonical spelling");
                    calls += 1;
                }
                Route::NoTool => nones += 1,
                Route::Answer(_) => answers += 1,
            }
        }
        assert!(calls >= 3 && nones >= 2 && answers >= 1);
    }

    #[test]
    fn a_phrase_example_says_only_what_its_result_holds() {
        for (asked, digest, reply) in PHRASE_EXAMPLES {
            let held = digest.replace(',', "");
            for number in crate::turn::numbers_in_for_tests(reply) {
                assert!(held.contains(&number), "{asked}: {number}");
            }
            assert!(!reply.contains('{') && !reply.starts_with('"'));
        }
    }

    // ---- the token estimate ----

    #[test]
    fn the_estimate_is_about_a_quarter_token_a_character_for_prose_and_never_zero() {
        assert_eq!(estimate_tokens(""), 2);
        let prose = "What is on my calendar today and tomorrow afternoon? ".repeat(8);
        let estimate = estimate_tokens(&prose);
        let chars = u32::try_from(prose.chars().count()).unwrap();
        assert!(
            estimate >= chars / 4 && estimate <= chars / 3,
            "{estimate} for {chars}"
        );
    }

    #[test]
    fn digits_dates_and_amounts_count_a_token_a_character() {
        // The tokenizer spells every digit alone, and the space or dash beside it.
        for text in [
            "2026 09 28 112 67 40 1234567890 ",
            "2026-09-28T14:30:00 2026-10-01 ",
            "ski rentals 240.00 USD, gas 61.18 USD",
        ] {
            let chars = u32::try_from(text.chars().count()).unwrap();
            assert!(
                estimate_tokens(text) >= chars / 2,
                "{text}: {}",
                estimate_tokens(text)
            );
        }
        let dates = "2026-09-28 ".repeat(30);
        assert!(estimate_tokens(&dates) >= u32::try_from(dates.len()).unwrap());
    }

    #[test]
    fn other_scripts_and_emoji_are_not_counted_like_english() {
        let cjk = "今天我有什么日程安排吗".repeat(10);
        let chars = u32::try_from(cjk.chars().count()).unwrap();
        assert!(
            estimate_tokens(&cjk) >= chars,
            "CJK is at least a token a character"
        );
        let emoji = "😀🎉🏔🚗".repeat(10);
        assert!(estimate_tokens(&emoji) >= 2 * u32::try_from(emoji.chars().count()).unwrap());
    }

    #[test]
    fn every_committed_prompt_in_both_styles_is_well_inside_the_window() {
        // The measured longest real prompt is 827 tokens (stock) in a 2048
        // window; the estimate, ~1.2x, must leave the phrase step its headroom.
        for style in [PromptStyle::Stock, PromptStyle::FineTuned] {
            let budget = Budget::DEFAULT.styled(style);
            let prompt = route_prompt(None, &[], "hello", budget);
            assert!(prompt.tokens < 1100, "{style:?}: {}", prompt.tokens);
            assert!(prompt.tokens <= budget.route_limit());
        }
    }
}
