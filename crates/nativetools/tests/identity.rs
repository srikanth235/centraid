//! The model's identity is one constant, and the prompt and the call reader
//! spell their tokens from it (`identity::MODEL`).

use centraid_nativetools::identity::{self, MODEL};
use centraid_nativetools::{parse, prompt};

#[test]
fn the_prompt_and_the_reader_use_the_models_markers() {
    assert_eq!(MODEL.tokenizer, "Qwen/Qwen3.5-0.8B");
    let block = prompt::tools_block(&prompt::tools());
    assert!(block.contains(&format!("\n{}\n{{", MODEL.tools_open)));
    assert!(block.contains(&format!("\n{}\n\n", MODEL.tools_close)));
    let example = format!(
        "{}\n{}example_function_name>\n{}example_parameter_1>\nvalue_1\n{}\n",
        MODEL.tool_call_open, MODEL.function_open, MODEL.parameter_open, MODEL.parameter_close
    );
    assert!(
        block.contains(&example),
        "the call example is the format the reader parses"
    );
    // What the model writes, spelled from the constants, is read back.
    let message = format!(
        "{}intent: read\n{}\n\n{}\n{}answer>\n{}rows>\n#1\n{}\n{}\n{}",
        MODEL.think_open,
        MODEL.think_close,
        MODEL.tool_call_open,
        MODEL.function_open,
        MODEL.parameter_open,
        MODEL.parameter_close,
        MODEL.function_close,
        MODEL.tool_call_close,
    );
    let call = parse::parse_call(&message).unwrap();
    assert_eq!(call["tool"], "answer");
    assert_eq!(call["args"]["rows"], serde_json::json!(["#1"]));
}

#[test]
fn identity_json_is_the_struct() {
    let value = identity::json();
    assert_eq!(value["tokenizer"], MODEL.tokenizer);
    assert_eq!(value["im_end"], MODEL.im_end);
    assert_eq!(value.as_object().unwrap().len(), 15);
}
