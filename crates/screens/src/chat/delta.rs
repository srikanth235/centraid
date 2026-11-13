//! A STREAMING ANSWER'S NEXT WORDS, SENT ALONE (#1188 C14). When the only thing that moved between
//! two views of a chat is that the last message grew at its end (and the status line changed),
//! the update carries those words instead of the whole chat. The comparison takes the changing
//! parts out of both views, compares the rest as it is, and puts them back: no copy of the chat.

use centraid_api_proto::core_v1 as wire;
use wire::view_state::Kind;

struct Parts {
    id: u64,
    text: String,
    label: String,
    activity: String,
}

fn take(view: &mut wire::ViewState) -> Option<Parts> {
    let Some(Kind::Chat(state)) = view.kind.as_mut() else {
        return None;
    };
    let activity = std::mem::take(&mut state.activity);
    let Some(last) = state.messages.last_mut() else {
        state.activity = activity;
        return None;
    };
    Some(Parts {
        id: last.id,
        text: std::mem::take(&mut last.text),
        label: std::mem::take(&mut last.accessibility_label),
        activity,
    })
}

fn put(view: &mut wire::ViewState, parts: Parts) {
    if let Some(Kind::Chat(state)) = view.kind.as_mut() {
        state.activity = parts.activity;
        if let Some(last) = state.messages.last_mut() {
            last.text = parts.text;
            last.accessibility_label = parts.label;
        }
    }
}

/// What the last message gained between `prev` and `next`, when that is all that changed besides
/// the status line and the message's spoken label. Both views are left as they were.
pub fn append(prev: &mut wire::ViewState, next: &mut wire::ViewState) -> Option<wire::ChatAppend> {
    let before = take(prev)?;
    let Some(after) = take(next) else {
        put(prev, before);
        return None;
    };
    let rest_is_equal = prev.instance == next.instance && prev.kind == next.kind;
    let grew = before.id == after.id
        && after.text.len() > before.text.len()
        && after.text.starts_with(&before.text);
    let out = (rest_is_equal && grew).then(|| wire::ChatAppend {
        message_id: after.id,
        text: after.text[before.text.len()..].to_owned(),
        activity: after.activity.clone(),
    });
    put(prev, before);
    put(next, after);
    out
}

/// A delta applied to a held view: the reproduction the shells' stores each do.
pub fn apply(view: &mut wire::ViewState, add: &wire::ChatAppend) -> bool {
    let Some(Kind::Chat(state)) = view.kind.as_mut() else {
        return false;
    };
    let Some(message) = state
        .messages
        .iter_mut()
        .rev()
        .find(|message| message.id == add.message_id)
    else {
        return false;
    };
    message.text.push_str(&add.text);
    state.activity.clone_from(&add.activity);
    true
}

/// A whole delta applied to a held view, as every store does: it is dropped unless it was made
/// against the revision the view holds, and unless the message it grows is there.
pub fn apply_view(view: &mut wire::ViewState, delta: &wire::ViewDelta) -> bool {
    let Some(wire::view_delta::Kind::ChatAppend(add)) = delta.kind.as_ref() else {
        return false;
    };
    if view.revision != delta.base || !apply(view, add) {
        return false;
    }
    view.revision = delta.revision;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(messages: &[(u64, &str)], activity: &str, revision: u64) -> wire::ViewState {
        wire::ViewState {
            instance: 1,
            revision,
            kind: Some(Kind::Chat(Box::new(wire::ChatState {
                activity: activity.to_owned(),
                streaming: true,
                messages: messages
                    .iter()
                    .map(|(id, text)| wire::ChatMessage {
                        id: *id,
                        text: (*text).to_owned(),
                        accessibility_label: format!("Answer: {text}"),
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }))),
        }
    }

    #[test]
    fn a_token_update_carries_only_the_appended_text_whatever_the_chat_holds() {
        use prost::Message as _;
        let mut sizes = Vec::new();
        for earlier in [2usize, 200, 2000] {
            let mut messages: Vec<(u64, String)> = (0..earlier as u64)
                .map(|id| (id, format!("an earlier message, number {id}")))
                .collect();
            messages.push((9999, "The answer so far".to_owned()));
            let held: Vec<(u64, &str)> = messages.iter().map(|(i, t)| (*i, t.as_str())).collect();
            let mut prev = chat(&held, "Thinking", 3);
            let mut grown = messages.clone();
            grown.last_mut().unwrap().1.push_str(" grows");
            let next_held: Vec<(u64, &str)> = grown.iter().map(|(i, t)| (*i, t.as_str())).collect();
            let mut next = chat(&next_held, "", 0);
            let add = append(&mut prev, &mut next).expect("a growth at the end");
            assert_eq!(add.text, " grows");
            sizes.push(add.encoded_len());
            // both views are as they were
            assert_eq!(prev, chat(&held, "Thinking", 3));
            assert_eq!(next, chat(&next_held, "", 0));
        }
        assert!(sizes.windows(2).all(|pair| pair[0] == pair[1]), "{sizes:?}");
    }

    #[test]
    fn anything_but_growth_at_the_end_is_a_full_view() {
        let mut prev = chat(&[(1, "q"), (2, "abc")], "", 1);
        // a message was added
        let mut next = chat(&[(1, "q"), (2, "abc"), (3, "")], "", 0);
        assert!(append(&mut prev, &mut next).is_none());
        // the text was rewritten, not extended
        let mut next = chat(&[(1, "q"), (2, "abX")], "", 0);
        assert!(append(&mut prev, &mut next).is_none());
        // an earlier message changed too
        let mut next = chat(&[(1, "changed"), (2, "abcd")], "", 0);
        assert!(append(&mut prev, &mut next).is_none());
        // another field moved
        let mut next = chat(&[(1, "q"), (2, "abcd")], "", 0);
        if let Some(Kind::Chat(state)) = next.kind.as_mut() {
            state.streaming = false;
        }
        assert!(append(&mut prev, &mut next).is_none());
    }

    /// The shared fixture: the same cases every store applies (`mobile/fixtures/chat-deltas.txt`).
    #[test]
    fn applying_the_fixtures_deltas_in_order_reproduces_the_state() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../mobile/fixtures/chat-deltas.txt"
        );
        let text = std::fs::read_to_string(path).unwrap();
        let kept: Vec<&str> = text
            .lines()
            .filter(|line| !line.starts_with("# "))
            .collect();
        let cases: Vec<String> = kept
            .join("\n")
            .split("\n====\n")
            .map(str::to_owned)
            .collect();
        assert!(cases.len() >= 4);
        let field = |case: &str, key: &str| -> String {
            case.lines()
                .find_map(|line| line.strip_prefix(key))
                .unwrap_or_default()
                .trim()
                .to_owned()
        };
        let pairs = |line: &str| -> Vec<(u64, String)> {
            line.split(';')
                .filter(|part| !part.is_empty())
                .map(|part| {
                    let (id, text) = part.split_once('=').unwrap();
                    (id.parse().unwrap(), text.to_owned())
                })
                .collect()
        };
        for case in cases {
            let name = field(&case, "name:");
            let held = pairs(&field(&case, "messages:"));
            let held_ref: Vec<(u64, &str)> = held.iter().map(|(i, t)| (*i, t.as_str())).collect();
            let mut view = chat(
                &held_ref,
                &field(&case, "activity:"),
                field(&case, "revision:").parse().unwrap(),
            );
            let deltas = case
                .split("--- deltas\n")
                .nth(1)
                .unwrap()
                .split("\n--- expect")
                .next()
                .unwrap();
            for line in deltas.lines() {
                let parts: Vec<&str> = line.splitn(5, '|').collect();
                let delta = wire::ViewDelta {
                    instance: 1,
                    base: parts[0].parse().unwrap(),
                    revision: parts[1].parse().unwrap(),
                    kind: Some(wire::view_delta::Kind::ChatAppend(wire::ChatAppend {
                        message_id: parts[2].parse().unwrap(),
                        activity: parts[3].to_owned(),
                        text: parts[4].to_owned(),
                    })),
                };
                apply_view(&mut view, &delta);
            }
            let expect = case.split("--- expect\n").nth(1).unwrap();
            let Some(Kind::Chat(state)) = view.kind.as_ref() else {
                panic!()
            };
            let got: Vec<String> = state
                .messages
                .iter()
                .map(|m| format!("{}={}", m.id, m.text))
                .collect();
            assert_eq!(
                field(expect, "revision:"),
                view.revision.to_string(),
                "{name}"
            );
            assert_eq!(field(expect, "activity:"), state.activity, "{name}");
            assert_eq!(field(expect, "messages:"), got.join(";"), "{name}");
        }
    }
}
