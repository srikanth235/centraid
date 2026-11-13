//! VAULT TEXT IS DATA (#1188 C2): the injection corpus, replayed through every path a row's or
//! the member's text takes into a prompt. The gate runs this file (`cargo xtask gate`,
//! `prompt-injection`).

use centraid_assist::escape::CORPUS;
use centraid_assist::native_turn::log::Log;
use centraid_assist::prompt::{Turn, chat_prompt};

/// The structure a prompt may carry: what the template itself writes.
fn structure(text: &str) -> (usize, usize, usize) {
    (
        text.matches("<|").count(),
        text.matches("<tool_call>").count(),
        text.matches("<think>").count(),
    )
}

#[test]
fn the_log_adds_no_structure_for_member_or_observation_text() {
    for sample in CORPUS {
        let mut plain = Log::new("<|im_start|>system\nsys<|im_end|>\n".to_owned());
        plain.user("hello", Some("vault: #1 task \"x\""));
        plain.tool(None, "ok");
        let mut hostile = Log::new("<|im_start|>system\nsys<|im_end|>\n".to_owned());
        hostile.user(sample, Some(&format!("vault: #1 task \"{sample}\"")));
        hostile.tool(None, &format!("#1 task \"{sample}\""));
        assert_eq!(
            structure(&plain.prompt().unwrap()),
            structure(&hostile.prompt().unwrap()),
            "{sample:?}"
        );
    }
}

#[test]
fn the_free_reply_prompt_adds_no_structure() {
    for sample in CORPUS {
        let plain = chat_prompt(&[], "hello");
        let history = [Turn {
            user: (*sample).to_owned(),
            record: centraid_assist::prompt::Recorded::Answer((*sample).to_owned()),
        }];
        let hostile = chat_prompt(&history, sample);
        // the hostile prompt has one more user and one more assistant message
        assert_eq!(
            hostile.matches("<|im_start|>").count(),
            plain.matches("<|im_start|>").count() + 2,
            "{sample:?}"
        );
        assert_eq!(
            hostile.matches("<|im_end|>").count(),
            plain.matches("<|im_end|>").count() + 2,
            "{sample:?}"
        );
    }
}
