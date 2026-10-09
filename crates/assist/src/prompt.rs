//! THE PROMPT PIECES the path beside the native runtime shares: Qwen's ChatML, the turn a thread
//! stores, and the token budget.
//!
//! The native plane's own prompt (the tool list, the kind card, the conversation) is
//! [`crate::native::prompt`] and [`crate::native_turn::log`]. What is here is everything else the
//! model is asked: **an attachment** ([`crate::attach::attach_prompt`]), a photograph or a
//! document and a question, built from [`message`], [`question`] and the budget below. It is off
//! in the shipped build (R-1088-19), and so is the free reply that once stood beside it: the
//! shipped model writes the tool format for any prose prompt.
//!
//! # THE BUDGET
//!
//! The engine's context is [`Budget::context`] tokens. Nothing here can count real tokens (the
//! tokenizer is the engine's), so [`estimate_tokens`] is a deliberately pessimistic character
//! count; a prompt stays under the window even when the estimate is generous, and the engine's
//! own count is what [`crate::model::ModelError::ContextExceeded`] reports if the two ever
//! disagree. A turn with an attachment is the prompt that can use the most of it
//! ([`Budget::attach_limit`]).

/// How many earlier turns ride in an attachment's prompt.
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
    /// It answered over an attachment. The attachment prompt shows it, under the turn's marker
    /// line.
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

pub(crate) fn message(role: &str, content: &str) -> String {
    format!("<|im_start|>{role}\n{content}{END_OF_TURN}\n")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attach::{Attachments, TextDoc, attach_prompt};

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
    fn the_question_is_one_line_and_capped() {
        let long = format!("a\n\nb {}", "x".repeat(600));
        let asked = question(&long);
        assert!(asked.starts_with("a b xxx"));
        assert_eq!(asked.chars().count(), USER_MAX);
        assert_eq!(normalize("  a \t b\n"), "a b");
    }

    #[test]
    fn only_the_last_two_turns_that_said_something_ride_along() {
        let mut history: Vec<Turn> = (1..=4).map(recorded).collect();
        history.push(Turn {
            user: "refused".to_owned(),
            record: Recorded::NoTool,
        });
        history.push(Turn {
            user: "a photo".to_owned(),
            record: Recorded::Attachment("A river.".to_owned()),
        });
        let doc = Attachments {
            image: None,
            doc: Some(TextDoc {
                name: "List".to_owned(),
                text: "Item 1\n".to_owned(),
            }),
        };
        let prompt = attach_prompt(&history, &doc, "and tomorrow?", Budget::DEFAULT).text;
        assert!(!prompt.contains("question 3") && !prompt.contains("refused"));
        assert!(prompt.contains("question 4"));
        assert!(prompt.contains("<|im_start|>assistant\nanswer 4<|im_end|>"));
        assert!(prompt.contains("<|im_start|>assistant\nA river.<|im_end|>"));
    }

    #[test]
    fn a_stored_turn_reads_back_whatever_record_it_holds() {
        let turns = [
            recorded(1),
            Turn {
                user: "hi".to_owned(),
                record: Recorded::Answer("Hello.".to_owned()),
            },
            Turn {
                user: "weather?".to_owned(),
                record: Recorded::NoTool,
            },
            Turn {
                user: "[Photo: river] what is this?".to_owned(),
                record: Recorded::Attachment("A river bend.".to_owned()),
            },
        ];
        for turn in turns {
            assert_eq!(Turn::from_json(&turn.to_json()), Some(turn));
        }
    }

    #[test]
    fn a_thread_stored_before_the_native_plane_still_reads() {
        // The shapes the routed plane stored (#1078): `tool`, `answer` and `no_tool`. A thread
        // holding them must reopen, so they stay readable although nothing writes them now.
        let tool = r#"{"user":"What is due today?","record":{"kind":"tool","call_json":"{\"tool\":\"tasks.list\",\"args\":{\"view\":\"today\"}}","headline":"2 tasks due today","answer":"Two things are due."}}"#;
        assert_eq!(
            Turn::from_json(tool),
            Some(Turn {
                user: "What is due today?".to_owned(),
                record: Recorded::Tool {
                    call_json: r#"{"tool":"tasks.list","args":{"view":"today"}}"#.to_owned(),
                    headline: "2 tasks due today".to_owned(),
                    answer: "Two things are due.".to_owned(),
                },
            })
        );
        assert_eq!(
            Turn::from_json(r#"{"user":"weather?","record":{"kind":"no_tool"}}"#),
            Some(Turn {
                user: "weather?".to_owned(),
                record: Recorded::NoTool,
            })
        );
    }

    #[test]
    fn a_record_this_build_cannot_read_is_no_history() {
        for text in [
            "",
            "not json",
            r#"{"user":"q"}"#,
            r#"{"user":"q","record":{"kind":"mystery"}}"#,
            r#"{"user":"q","record":{"kind":"tool","call_json":"{}"}}"#,
        ] {
            assert_eq!(Turn::from_json(text), None, "{text}");
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
}
