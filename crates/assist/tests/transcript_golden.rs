//! The Rust transcript renderer against the output of the last Python renderer (#1088).
//!
//! `fixtures/transcript_golden.jsonl.gz` is written by `experiments/toolchat/native/train/render_golden.py` from the
//! first train records and a few synthetic cases; every case holds the render records, the text `render.py` made of
//! them, its loss spans (in code points) and the generation prompt at every assistant message. The Rust text, spans and
//! prompts must equal them byte for byte.

use std::collections::BTreeMap;
use std::io::Read as _;

use centraid_assist::native::transcript::{
    Message, Rendered, answer_line, render, render_prompt_for_generation,
};
use flate2::read::GzDecoder;
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    messages: Vec<Message>,
    text: String,
    spans: Vec<(usize, usize)>,
    prompts: BTreeMap<String, String>,
}

fn cases() -> Vec<Case> {
    let bytes = include_bytes!("fixtures/transcript_golden.jsonl.gz");
    let mut text = String::new();
    GzDecoder::new(&bytes[..])
        .read_to_string(&mut text)
        .expect("the golden file is gzip");
    text.lines()
        .map(|line| serde_json::from_str(line).expect("a golden case"))
        .collect()
}

#[test]
fn every_golden_case_renders_byte_for_byte() {
    let cases = cases();
    assert!(
        cases.len() >= 20,
        "{} cases: the train records and the synthetic ones",
        cases.len()
    );
    for case in &cases {
        let Rendered { text, spans } = render(&case.messages).expect(&case.name);
        assert_eq!(text, case.text, "{}: text", case.name);
        assert_eq!(spans, case.spans, "{}: spans", case.name);
        for (index, want) in &case.prompts {
            let at: usize = index.parse().unwrap();
            let got = render_prompt_for_generation(&case.messages[..at]).expect(&case.name);
            assert_eq!(&got, want, "{}: the prompt before message {at}", case.name);
        }
    }
}

#[test]
fn the_spans_are_code_points_and_the_golden_data_is_not_ascii() {
    let mut multibyte = 0;
    for case in cases() {
        let rendered = render(&case.messages).unwrap();
        let chars: Vec<char> = rendered.text.chars().collect();
        let bytes = rendered.byte_spans();
        for ((start, end), (from, to)) in rendered.spans.iter().zip(&bytes) {
            let by_chars: String = chars[*start..*end].iter().collect();
            assert_eq!(by_chars, rendered.text[*from..*to], "{}", case.name);
            assert!(by_chars.ends_with("<|im_end|>"), "{}", case.name);
            if rendered.text.len() != chars.len() {
                multibyte += 1;
            }
        }
    }
    assert!(multibyte > 0, "a golden case has text that is not ASCII");
}

#[test]
fn the_line_protocol_answers_what_render_does() {
    let case = cases().into_iter().nth(1).unwrap();
    let request = serde_json::json!({"op": "render", "messages": []}).to_string();
    assert!(
        answer_line(&request).is_some_and(|line| line.contains("\"text\":\"\"")),
        "an empty transcript is the empty text"
    );
    let rendered = render(&case.messages).unwrap();
    // the records as the golden file wrote them, handed back to the protocol as one line
    let bytes = include_bytes!("fixtures/transcript_golden.jsonl.gz");
    let mut text = String::new();
    GzDecoder::new(&bytes[..])
        .read_to_string(&mut text)
        .unwrap();
    let line = text.lines().nth(1).unwrap();
    let start = line.find("\"messages\": ").unwrap() + "\"messages\": ".len();
    let end = line.find(", \"text\":").unwrap();
    let request = format!("{{\"op\":\"render\",\"messages\":{}}}", &line[start..end]);
    let answer: serde_json::Value = serde_json::from_str(&answer_line(&request).unwrap()).unwrap();
    assert_eq!(answer["text"], rendered.text);
    assert_eq!(answer["spans"], serde_json::json!(rendered.spans));
    let request = request.replacen("\"render\"", "\"prompt\"", 1);
    let answer: serde_json::Value = serde_json::from_str(&answer_line(&request).unwrap()).unwrap();
    assert_eq!(
        answer["prompt"],
        render_prompt_for_generation(&case.messages).unwrap()
    );
    // many transcripts in one request answer as each would alone, a refusal in its own place
    let again = request.replacen("\"prompt\"", "\"render\"", 1);
    let messages = &again["{\"op\":\"render\",\"messages\":".len()..again.len() - 1];
    let many = format!(
        "{{\"op\":\"render_many\",\"conversations\":[{messages},[{{\"role\":\"tool\",\"content\":\"x\"}},{{\"role\":\"system\",\"content\":\"s\"}}],{messages}]}}"
    );
    let many: serde_json::Value = serde_json::from_str(&answer_line(&many).unwrap()).unwrap();
    let renders = many["renders"].as_array().unwrap();
    assert_eq!(renders.len(), 3);
    assert_eq!(renders[0]["text"], rendered.text);
    assert_eq!(renders[2], renders[0]);
    assert!(renders[1]["error"].is_string());
    // a refusal is an answer; another op's line is not ours, spelled compactly or not
    let late = r#"{"op":"render","messages":[{"role":"user","content":"x"},{"role":"system","content":"s"}]}"#;
    assert!(
        answer_line(late)
            .unwrap()
            .contains("system message must come first")
    );
    assert!(answer_line(r#"{ "op": "render", "messages": [] }"#).is_some());
    assert!(answer_line(r#"{"op":"compile"}"#).is_none());
}
