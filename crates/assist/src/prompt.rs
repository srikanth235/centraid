//! THE PROMPT PIECES the paths around the native runtime share: Qwen's ChatML, the free reply's
//! prompt, the turn a thread stores, and the token budget.
//!
//! The native plane's own prompt (the tool list, the kind card, the conversation) is
//! [`crate::native::prompt`] and [`crate::native_turn::log`]. What is here is everything else the
//! model is asked:
//!
//! 1. **The free reply** ([`chat_prompt`]): a question the vault cannot answer ("hi", "what can
//!    you do?") gets a few unconstrained words, told it has read nothing.
//! 2. **An attachment** ([`crate::attach::attach_prompt`]): a photograph or a document and a
//!    question, built from [`message`], [`question`] and the budget below.
//!
//! # THE BUDGET
//!
//! The engine's context is [`Budget::context`] tokens. Nothing here can count real tokens (the
//! tokenizer is the engine's), so [`estimate_tokens`] is a deliberately pessimistic character
//! count; a prompt stays under the window even when the estimate is generous, and the engine's
//! own count is what [`crate::model::ModelError::ContextExceeded`] reports if the two ever
//! disagree. A turn with an attachment is the prompt that can use the most of it
//! ([`Budget::attach_limit`]).

/// How many earlier turns ride in the free reply's and an attachment's prompt.
pub const HISTORY_TURNS: usize = 2;

/// The longest question the plane reads, in characters.
pub const USER_MAX: usize = 400;

/// The end-of-turn marker the engine stops on.
pub const END_OF_TURN: &str = "<|im_end|>";

/// The context window the prompts plan inside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    /// The engine's context size, in tokens: what a turn with an attachment
    /// may use ([`Self::attach_limit`]).
    pub context: u32,
}

impl Budget {
    /// The engine's context, 8192 tokens: the length the native plane's model was trained on
    /// (R-1088-11). Kept equal to `centraid_assist_llama::Config`'s by that crate's tests.
    pub const DEFAULT: Self = Self { context: 8192 };

    /// What the prompt of a turn with an attachment may use: the context less
    /// the room its answer is allowed ([`crate::attach::ATTACH_MAX_TOKENS`]).
    pub const fn attach_limit(self) -> u32 {
        self.context
            .saturating_sub(crate::attach::ATTACH_MAX_TOKENS)
    }
}

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
/// | the plane's prompts (mean) | 4.0 |
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

/// One earlier turn: the member's line as the prompt holds it, and what the assistant said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub user: String,
    pub said: String,
}

pub(crate) fn message(role: &str, content: &str) -> String {
    format!("<|im_start|>{role}\n{content}{END_OF_TURN}\n")
}

/// A message whose content is the member's or a record's text, never the template's: it is made
/// unable to spell a special token first (#1188 C2).
pub(crate) fn data_message(role: &str, content: &str) -> String {
    message(role, &crate::escape::vault_text(content))
}

/// WHERE THE MODEL BEGINS: the assistant's turn, opened with an EMPTY thinking
/// block.
///
/// Qwen3.5's own chat template ends its generation prompt this way when
/// thinking is off (`enable_thinking` unset), and its models are trained to
/// answer after `</think>`. Without the block a Qwen3.5 opens `<think>` itself
/// and spends the token ceiling reasoning before it says a word of the reply.
/// The block is part of the prompt, not of the output.
pub const ASSISTANT_TURN: &str = "<|im_start|>assistant\n<think>\n\n</think>\n\n";

/// One line, single spaces, trimmed: how every piece of member text is held.
#[must_use]
pub fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The question as the prompt holds it: one line, at most [`USER_MAX`] characters.
#[must_use]
pub fn question(text: &str) -> String {
    normalize(text).chars().take(USER_MAX).collect()
}

/// FREE REPLY: what the model is told when the vault has no answer to give.
///
/// A question no read answers ("hi", "what can you do?", "text Sam") gets a short,
/// unconstrained reply streamed token by token, rather than the runtime's canned sentence
/// (`native_turn`, a decline `out_of_scope`). It reads nothing and does nothing, so it can only
/// talk; it is told so, told never to invent rows, and told it cannot act from this reply, so a
/// request to send, call or change something is never answered as if it had been done.
const CHAT_SYSTEM: &str = "You are Centraid, a private assistant that runs entirely on the member's phone. Their vault holds tasks, notes, documents, calendar events, people, photos and expenses. Reply in a few short, friendly sentences. You have not looked at their vault for this reply, so never state facts about their data; suggest a question about one of those apps instead. You cannot send messages, make calls or change anything from this reply, so never say or imply that you did; say plainly that you cannot, and offer what you can look up.";

/// The free-reply prompt: [`CHAT_SYSTEM`], the last [`HISTORY_TURNS`] turns
/// that said something, and the question, opened at [`ASSISTANT_TURN`].
#[must_use]
pub fn chat_prompt(history: &[Turn], user: &str) -> String {
    let shown: Vec<&Turn> = history
        .iter()
        .filter(|turn| !turn.said.is_empty())
        .collect();
    let mut out = message("system", CHAT_SYSTEM);
    for turn in &shown[shown.len().saturating_sub(HISTORY_TURNS)..] {
        out.push_str(&data_message("user", &turn.user));
        out.push_str(&data_message("assistant", &turn.said));
    }
    out.push_str(&data_message("user", &question(user)));
    out.push_str(ASSISTANT_TURN);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded(n: usize) -> Turn {
        Turn {
            user: format!("question {n}"),
            said: format!("answer {n}"),
        }
    }

    #[test]
    fn the_question_is_one_line_and_capped() {
        let long = format!("a\n\nb {}", "x".repeat(600));
        let asked = question(&long);
        assert!(asked.starts_with("a b xxx"));
        assert_eq!(asked.chars().count(), USER_MAX);
        assert_eq!(normalize("  a \t b\n"), "a b");
    }

    #[test]
    fn a_free_reply_prompt_is_chatml_ending_where_the_model_begins() {
        let prompt = chat_prompt(&[], "hello");
        assert!(prompt.starts_with("<|im_start|>system\nYou are Centraid"));
        assert!(prompt.ends_with(&format!(
            "<|im_start|>user\nhello<|im_end|>\n{ASSISTANT_TURN}"
        )));
    }

    #[test]
    fn the_free_reply_is_told_it_can_act_on_nothing() {
        let prompt = chat_prompt(&[], "text Sam that I am late");
        assert!(prompt.contains("cannot send messages, make calls or change anything"));
        assert!(prompt.contains("have not looked at their vault"));
    }

    #[test]
    fn only_the_last_two_turns_that_said_something_ride_along() {
        let mut history: Vec<Turn> = (1..=4).map(recorded).collect();
        history.push(Turn {
            user: "refused".to_owned(),
            said: String::new(),
        });
        history.push(Turn {
            user: "a photo".to_owned(),
            said: "A river.".to_owned(),
        });
        let prompt = chat_prompt(&history, "and tomorrow?");
        assert!(!prompt.contains("question 3") && !prompt.contains("refused"));
        assert!(prompt.contains("question 4"));
        assert!(prompt.contains("<|im_start|>assistant\nanswer 4<|im_end|>"));
        assert!(prompt.contains("<|im_start|>assistant\nA river.<|im_end|>"));
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
}
