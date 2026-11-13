//! THE ENGINE AGAINST A REAL MODEL FILE.
//!
//! Every test here is `#[ignore]`d and does nothing without `CENTRAID_ASSIST_MODEL`
//! naming a GGUF, because the model is half a gigabyte the repository does not
//! carry and a shell downloads:
//!
//! ```text
//! CENTRAID_ASSIST_MODEL=~/.cache/centraid/models/Qwen3.5-0.8B-Q4_0.gguf \
//!   cargo test --release -p centraid-assist-llama --features engine --test real_model -- --ignored --nocapture
//! ```
//!
//! What they assert is the engine's half of [`centraid_assist::Model`]'s
//! contract — a grammar is obeyed when one is sent, decoding is greedy and so
//! repeatable, a Cancel and a Stop end a generation as `Ok`, a prompt past the
//! window is a typed error, the token estimate never under-counts — and that the
//! native plane's step (a think, then one call) runs over it. How often a 0.8B
//! model picks the right call is the fine-tune's measurement, not this file's.
//!
//! The adapter tests (#1188) hold the rule the fine-tune rests on: an adapter that is attached
//! and off, or a zero-delta one that is on, leaves the output of the stock model byte for byte
//! as it was; a live one changes it only when asked; a file that is not an adapter is refused in
//! words. They build their adapters with `adapter::fixture` for Qwen3.5-0.8B's shapes (the FFN
//! of all 24 blocks), so they need the 0.8B file in `CENTRAID_ASSIST_MODEL`, and no trainer.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use centraid_assist::host::ModelLoader;
use centraid_assist::model::{AdapterUse, Cancel, Control, Finish, GenerateRequest, Model};
use centraid_assist::native::step::decode_step;
use centraid_assist::native::think::TraceMode;
use centraid_assist::native::transcript::render_prompt_for_generation;
use centraid_assist::prompt::{Budget, END_OF_TURN};
use centraid_assist_llama::adapter::fixture::{Fixture, write};
use centraid_assist_llama::{Config, LlamaLoader};

/// One model for the whole file: a load is seconds and the backend starts once
/// per process.
fn model() -> Option<Arc<dyn Model>> {
    static MODEL: OnceLock<Option<Arc<dyn Model>>> = OnceLock::new();
    MODEL
        .get_or_init(|| {
            let path = PathBuf::from(std::env::var_os("CENTRAID_ASSIST_MODEL")?);
            Some(
                LlamaLoader::new(Config::default())
                    .load(&path)
                    .expect("the model loads"),
            )
        })
        .clone()
}

fn request<'a>(
    prompt: &'a str,
    grammar: Option<&'a str>,
    max_tokens: u32,
    stop: &'a [&'a str],
    cancel: &'a Cancel,
) -> GenerateRequest<'a> {
    GenerateRequest {
        prompt,
        grammar,
        max_tokens,
        stop,
        temperature: 0.0,
        cancel,
        images: &[],
    }
}

/// The prompt of a native turn's first step: the system turn (today, the kind card, the tools of
/// the model record's mode, the one the phone sends) and one question, ending where the model
/// begins.
fn native_prompt(question: &str) -> String {
    use centraid_assist::native::prompt::{kind_card_for, py_json, tools_for};
    use centraid_assist::native::transcript::{Json, parse_messages};
    let mode = centraid_assist::native_turn::phone_options().tools;
    let system = format!(
        "today: Thursday 2026-10-08\nme: Me\n\nkinds:\n{}",
        kind_card_for(mode, "USD").join("\n")
    );
    let tools: Vec<String> = tools_for(mode).iter().map(py_json).collect();
    let records = format!(
        r#"[{{"role":"system","content":{},"tools":[{}]}},{{"role":"user","content":{}}}]"#,
        Json::str(&system).dumps(),
        tools.join(","),
        Json::str(question).dumps()
    );
    let messages = parse_messages(&records).expect("the records parse");
    render_prompt_for_generation(&messages).expect("the prompt renders")
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn a_native_step_is_one_whole_message_ending_in_one_call_and_is_repeatable() {
    let Some(model) = model() else { return };
    let cancel = Cancel::new();
    for question in ["what tasks do I have?", "who owes me money?", "hi"] {
        let prompt = native_prompt(question);
        let step = || {
            decode_step(
                &*model,
                &prompt,
                None,
                TraceMode::V4,
                // the options the phone decodes under: the record's tools, the think held to the grammar
                centraid_assist::native_turn::phone_options(),
                &cancel,
            )
            .expect("a step")
        };
        let first = step();
        assert!(
            first.info.stopped && !first.info.cancelled,
            "{question}: {first:?}"
        );
        assert!(
            first.text.starts_with("<think>\n"),
            "{question}: {}",
            first.text
        );
        assert!(
            first.text.trim_end().ends_with("</tool_call>"),
            "{question}: the message ends with its one call: {}",
            first.text
        );
        assert_eq!(
            first.text.matches("<tool_call>").count(),
            1,
            "{}",
            first.text
        );
        assert_eq!(step().text, first.text, "{question}: greedy is repeatable");
    }
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn a_grammar_the_model_does_not_want_is_still_obeyed() {
    let Some(model) = model() else { return };
    let cancel = Cancel::new();
    // The question asks for a poem; the grammar allows two words.
    let prompt = "<|im_start|>user\nWrite me a long poem about the sea.<|im_end|>\n\
                  <|im_start|>assistant\n<think>\n\n</think>\n\n";
    let grammar = r#"root ::= "yes" | "no""#;
    let generation = model
        .generate(
            &request(prompt, Some(grammar), 32, &[END_OF_TURN], &cancel),
            &mut |_| Control::Continue,
        )
        .expect("a generation");
    assert!(
        ["yes", "no"].contains(&generation.text.as_str()),
        "{:?}",
        generation.text
    );
    assert_eq!(generation.finish, Finish::Stop);

    // And a grammar llama.cpp cannot parse is a typed failure, not a crash.
    let broken = "root ::= ::= (";
    let error = model
        .generate(
            &request(prompt, Some(broken), 8, &[END_OF_TURN], &cancel),
            &mut |_| Control::Continue,
        )
        .expect_err("a broken grammar is refused");
    assert!(error.to_string().contains("grammar"), "{error}");
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn cancel_and_stop_end_a_generation_as_ok_and_stop_strings_are_not_in_the_text() {
    let Some(model) = model() else { return };
    let prompt = "<|im_start|>user\nCount from one to fifty in words.<|im_end|>\n\
                  <|im_start|>assistant\n<think>\n\n</think>\n\n";

    // Set before the call: nothing is read, nothing is said.
    let already = Cancel::new();
    already.cancel();
    let generation = model
        .generate(
            &request(prompt, None, 64, &[END_OF_TURN], &already),
            &mut |_| Control::Continue,
        )
        .expect("a cancelled generation is Ok");
    assert_eq!(generation.finish, Finish::Cancelled);
    assert!(generation.text.is_empty());

    // From another thread, mid-stream.
    let cancel = Cancel::new();
    let generation = std::thread::scope(|scope| {
        let handle = cancel.clone();
        let waiting = scope.spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            handle.cancel();
        });
        let generation = model
            .generate(
                &request(prompt, None, 400, &[END_OF_TURN], &cancel),
                &mut |_| Control::Continue,
            )
            .expect("a cancelled generation is Ok");
        waiting.join().expect("the canceller finishes");
        generation
    });
    assert_eq!(generation.finish, Finish::Cancelled);
    assert!(generation.generated_tokens < 400);

    // The callback saying Stop.
    let idle = Cancel::new();
    let mut heard = 0;
    let generation = model
        .generate(&request(prompt, None, 400, &[], &idle), &mut |_| {
            heard += 1;
            if heard >= 3 {
                Control::Stop
            } else {
                Control::Continue
            }
        })
        .expect("a stopped generation is Ok");
    assert_eq!(generation.finish, Finish::Cancelled);
    assert!(!generation.text.is_empty());

    // A stop string ends the text and is not in it.
    let generation = model
        .generate(&request(prompt, None, 400, &["five"], &idle), &mut |_| {
            Control::Continue
        })
        .expect("a generation");
    assert_eq!(generation.finish, Finish::Stop);
    assert!(!generation.text.contains("five"), "{:?}", generation.text);
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn a_prompt_longer_than_the_window_is_a_typed_error() {
    let Some(model) = model() else { return };
    let cancel = Cancel::new();
    let window = Config::default().context;
    let long = format!(
        "<|im_start|>user\n{}<|im_end|>\n",
        "word ".repeat(window as usize + 500)
    );
    let error = model
        .generate(
            &request(&long, None, 8, &[END_OF_TURN], &cancel),
            &mut |_| Control::Continue,
        )
        .expect_err("the prompt is longer than the window");
    assert!(
        matches!(
            error,
            centraid_assist::model::ModelError::ContextExceeded { held, .. } if held == window
        ),
        "{error}"
    );
}

/// The real tokenizer's count of `text`: a one-token generation reports it.
fn real_tokens(model: &Arc<dyn Model>, text: &str) -> u32 {
    let cancel = Cancel::new();
    model
        .generate(&request(text, None, 1, &[], &cancel), &mut |_| {
            Control::Continue
        })
        .expect("a generation")
        .prompt_tokens
}

/// THE TOKEN ESTIMATE AGAINST THE REAL TOKENIZER: it must never under-count,
/// on the plane's own prompts or on text a member could put in them.
///
/// `estimate_tokens` is what the budget trusts when it decides whether a prompt
/// fits; an under-count is a prompt the engine then refuses (`ContextExceeded`)
/// after the member waited for it. The table it prints is the one
/// `estimate_tokens`'s documentation quotes.
#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn the_token_estimate_never_undercounts_the_real_tokenizer() {
    use centraid_assist::attach::{Attachments, TextDoc, attach_prompt};
    use centraid_assist::prompt::{Recorded, Turn, chat_prompt, estimate_tokens};

    let Some(model) = model() else { return };
    let kinds: Vec<(&str, String)> = vec![
        (
            "english",
            "What is on my calendar today and tomorrow afternoon? ".repeat(8),
        ),
        ("digits", "2026 09 28 112 67 40 1234567890 ".repeat(12)),
        ("dates", "2026-09-28T14:30:00 2026-10-01 ".repeat(12)),
        (
            "money",
            "groceries 112.67 USD, ski rentals 240.00 USD, gas 61.18 USD. ".repeat(5),
        ),
        (
            "json",
            r#"{"tool":"agenda.task_list","args":{"view":"today"}}"#.repeat(8),
        ),
        ("punctuation", "!?;:,.()[]{}<>/\\|-_=+*&^%$#@~ ".repeat(10)),
        (
            "cjk",
            "今天我有什么日程安排吗请告诉我明天下午的会议".repeat(8),
        ),
        ("emoji", "😀🎉🏔️🚗📷✅🙂🌲".repeat(25)),
        (
            "accents",
            "Müller café naïve résumé Ångström señor façade ".repeat(8),
        ),
        (
            "cyrillic",
            "Что у меня запланировано на сегодня и завтра ".repeat(8),
        ),
        (
            "arabic",
            "ماذا لدي في التقويم اليوم وغدا بعد الظهر ".repeat(8),
        ),
        ("url", "https://example.com/a/b/c?x=1&y=2#frag ".repeat(10)),
        ("hex", "3f9a1c7e5b2d4086a1b2c3d4e5f60718 ".repeat(10)),
    ];
    println!(
        "{:<14} {:>6} {:>6} {:>10} {:>9}",
        "text", "chars", "real", "chars/tok", "estimate"
    );
    for (name, text) in &kinds {
        let real = real_tokens(&model, text);
        let estimate = estimate_tokens(text);
        println!(
            "{name:<14} {:>6} {real:>6} {:>10.2} {estimate:>9}  ({:.2}x)",
            text.chars().count(),
            text.chars().count() as f64 / f64::from(real),
            f64::from(estimate) / f64::from(real)
        );
        assert!(
            estimate >= real,
            "{name}: estimated {estimate}, really {real}"
        );
    }

    println!(
        "{:<14} {:>6} {:>6} {:>10} {:>9}",
        "text", "chars", "real", "chars/tok", "estimate"
    );
    for (name, text) in &kinds {
        let real = real_tokens(&model, text);
        let estimate = estimate_tokens(text);
        println!(
            "{name:<14} {:>6} {real:>6} {:>10.2} {estimate:>9}  ({:.2}x)",
            text.chars().count(),
            text.chars().count() as f64 / f64::from(real),
            f64::from(estimate) / f64::from(real)
        );
        assert!(
            estimate >= real,
            "{name}: estimated {estimate}, really {real}"
        );
    }

    // The plane's own prompts: a native step's, the free reply's after two turns, and an
    // attachment's over a document.
    let history = [
        Turn {
            user: "what tasks do I have?".to_owned(),
            record: Recorded::Answer("Found 12 tasks. Showing 6.".to_owned()),
        },
        Turn {
            user: "[Document: Tahoe packing list] what should I bring?".to_owned(),
            record: Recorded::Attachment("The tent, the stove and a headlamp.".to_owned()),
        },
    ];
    let document = Attachments {
        image: None,
        doc: Some(TextDoc {
            name: "Tahoe packing list".to_owned(),
            text: "Item 1: a tent\nItem 2: a stove, 2.5 kg\nItem 3: a headlamp, 3 batteries\n"
                .repeat(40),
        }),
    };
    let budget = Budget::DEFAULT;
    let mut worst = f64::MAX;
    for (label, text) in [
        ("native step", native_prompt("what tasks do I have?")),
        (
            "free reply",
            chat_prompt(&history, "text Sam that I am late"),
        ),
        (
            "attachment",
            attach_prompt(&history, &document, "what should I bring?", budget).text,
        ),
    ] {
        let real = real_tokens(&model, &text);
        let estimate = estimate_tokens(&text);
        assert!(
            estimate >= real,
            "{label}: estimated {estimate}, really {real}"
        );
        assert!(
            real + 512 <= budget.context,
            "{label}: {real} real tokens leave a step's 512 no room in {}",
            budget.context
        );
        worst = worst.min(f64::from(estimate) / f64::from(real));
        println!("{label:<12} real {real:>5} estimate {estimate:>5}");
    }
    println!("estimate/real over the plane's prompts: min {worst:.2}x");
}

/// Qwen3.5-0.8B's FFN LoRA pairs (rank 8) for all 24 blocks. `strength` is the standard deviation
/// of both factors' values: `0.0` is an all-zero delta.
fn ffn_adapter(path: &std::path::Path, strength: f32) {
    const RANK: u64 = 8;
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut value = move || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        // Uniform in [-1, 1) scaled to the requested spread.
        (((state >> 40) as f32) / 8_388_608.0 - 1.0) * strength
    };
    let mut tensors = Vec::new();
    for block in 0..24 {
        for (module, ne_in, ne_out) in [
            ("ffn_gate", 1024u64, 3584u64),
            ("ffn_up", 1024, 3584),
            ("ffn_down", 3584, 1024),
        ] {
            let a: Vec<f32> = (0..ne_in * RANK).map(|_| value()).collect();
            let b: Vec<f32> = (0..RANK * ne_out).map(|_| value()).collect();
            tensors.push((
                format!("blk.{block}.{module}.weight.lora_a"),
                [ne_in, RANK],
                a,
            ));
            tensors.push((
                format!("blk.{block}.{module}.weight.lora_b"),
                [RANK, ne_out],
                b,
            ));
        }
    }
    let fixture = Fixture {
        architecture: "qwen35",
        general_type: "adapter",
        adapter_type: "lora",
        alpha: 16.0,
        tensors,
    };
    write(path, &fixture).expect("the adapter fixture is written");
}

fn model_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("CENTRAID_ASSIST_MODEL")?))
}

/// The stock model's answer, from a model loaded with no adapter at all.
fn stock_text() -> Option<String> {
    let model = LlamaLoader::new(Config::default())
        .load(&model_path()?)
        .expect("the model loads");
    Some(adapter_text(&*model, AdapterUse::Off))
}

/// A model loaded with the adapter at `file`.
fn with_adapter(file: &std::path::Path) -> Arc<dyn Model> {
    LlamaLoader::new(Config::default())
        .load_with_adapter(&model_path().expect("set"), Some(file))
        .expect("the model and its adapter load")
}

fn adapter_text(model: &dyn Model, adapter: AdapterUse) -> String {
    let prompt = native_prompt("what tasks do I have?");
    let cancel = Cancel::new();
    let ask = request(&prompt, None, 32, &[], &cancel);
    model
        .generate_with(&ask, adapter, &mut |_| Control::Continue)
        .expect("a generation")
        .text
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("centraid-real-adapter-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a temp directory");
    dir.join(name)
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn a_loaded_adapter_that_is_off_or_zero_changes_nothing() {
    let Some(stock) = stock_text() else { return };
    let file = scratch("zero.gguf");
    ffn_adapter(&file, 0.0);
    let model = with_adapter(&file);
    assert_eq!(
        adapter_text(&*model, AdapterUse::Off),
        stock,
        "loaded and off"
    );
    assert_eq!(
        adapter_text(&*model, AdapterUse::On),
        stock,
        "a zero delta, on"
    );
    // `generate` is `generate_with(.., Off, ..)`.
    let prompt = native_prompt("what tasks do I have?");
    let cancel = Cancel::new();
    let plain = model
        .generate(&request(&prompt, None, 32, &[], &cancel), &mut |_| {
            Control::Continue
        })
        .expect("a generation")
        .text;
    assert_eq!(plain, stock, "generate");
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn a_live_adapter_changes_the_output_only_when_asked() {
    let Some(stock) = stock_text() else { return };
    let file = scratch("live.gguf");
    ffn_adapter(&file, 0.3);
    let model = with_adapter(&file);
    assert_eq!(
        adapter_text(&*model, AdapterUse::Off),
        stock,
        "off, after loading"
    );
    let on = adapter_text(&*model, AdapterUse::On);
    assert_ne!(on, stock, "on");
    assert_eq!(
        adapter_text(&*model, AdapterUse::On),
        on,
        "on is repeatable"
    );
    assert_eq!(
        adapter_text(&*model, AdapterUse::Off),
        stock,
        "off again, on the same model"
    );
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn on_without_an_adapter_is_the_stock_model() {
    let Some(stock) = stock_text() else { return };
    let model = LlamaLoader::new(Config::default())
        .load_with_adapter(&model_path().expect("set"), None)
        .expect("loads");
    assert_eq!(adapter_text(&*model, AdapterUse::On), stock);
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn a_file_that_is_not_an_adapter_for_this_model_is_refused_in_words() {
    use centraid_assist::model::ModelError;
    let Some(base) = model_path() else { return };
    let loader = LlamaLoader::new(Config::default());
    let refused = |file: &std::path::Path| match loader.load_with_adapter(&base, Some(file)) {
        Err(ModelError::AdapterLoad(why)) => why,
        Err(other) => panic!("not an adapter load error: {other}"),
        Ok(_) => panic!("{} was accepted", file.display()),
    };
    assert!(refused(&base).contains("not an adapter"));
    assert!(refused(&scratch("nowhere.gguf")).contains("cannot be read"));
    // Right kind, wrong shapes: llama.cpp's own check, wrapped.
    let wrong = scratch("wrong.gguf");
    write(
        &wrong,
        &Fixture {
            architecture: "qwen35",
            general_type: "adapter",
            adapter_type: "lora",
            alpha: 8.0,
            tensors: vec![
                (
                    "blk.0.ffn_down.weight.lora_a".to_owned(),
                    [7, 2],
                    vec![0.0; 14],
                ),
                (
                    "blk.0.ffn_down.weight.lora_b".to_owned(),
                    [2, 5],
                    vec![0.0; 10],
                ),
            ],
        },
    )
    .expect("written");
    assert!(refused(&wrong).contains("llama.cpp refused"));
    // Another architecture is named before llama.cpp is asked.
    let llama = scratch("llama.gguf");
    write(
        &llama,
        &Fixture {
            architecture: "llama",
            general_type: "adapter",
            adapter_type: "lora",
            alpha: 8.0,
            tensors: vec![],
        },
    )
    .expect("written");
    assert!(refused(&llama).contains("made for 'llama'"));
}
