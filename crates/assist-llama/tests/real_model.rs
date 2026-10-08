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
//! contract — the grammar is obeyed, decoding is greedy and so repeatable, a
//! Cancel and a Stop end a generation as `Ok` — and not how often a 0.8B model
//! picks the right tool, which is `assist-eval-llama`'s number.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use centraid_assist::eval::{EvalFile, judge};
use centraid_assist::grammar::route_gbnf;
use centraid_assist::host::ModelLoader;
use centraid_assist::model::{Cancel, Control, Finish, GenerateRequest, Model};
use centraid_assist::prompt::{Budget, END_OF_TURN};
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

fn eval_file() -> EvalFile {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/assist/eval-cases.json"
    );
    EvalFile::parse(&std::fs::read_to_string(path).expect("the fixture")).expect("a valid fixture")
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

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn every_route_is_one_the_grammar_allows_and_a_run_is_repeatable() {
    let Some(model) = model() else { return };
    let file = eval_file();
    let cancel = Cancel::new();
    for case in file.cases.iter().step_by(4) {
        let prompt = case.prompt(Budget::DEFAULT).expect("a prompt");
        let grammar = route_gbnf(&prompt.tools);
        let ask = || {
            model
                .generate(
                    &request(&prompt.text, Some(&grammar), 96, &[END_OF_TURN], &cancel),
                    &mut |_| Control::Continue,
                )
                .expect("a generation")
        };
        let first = ask();
        assert_eq!(first.finish, Finish::Stop, "{}: {}", case.id, first.text);
        // Whatever the model chose, it is a route: `judge` parses it against the
        // tools the prompt offered, and a grammar escape would be a parse error
        // and so `kind_ok == false` on a case that expects any call at all.
        let judged = judge(case, &first.text, &prompt.tools).expect("a judgement");
        assert!(
            centraid_assist::call::parse_route(&first.text, &prompt.tools).is_ok(),
            "{}: {} (kind_ok={})",
            case.id,
            first.text,
            judged.kind_ok
        );
        assert_eq!(ask().text, first.text, "{}: greedy is repeatable", case.id);
        assert!(first.prompt_tokens > 100 && first.prompt_tokens < 2048);
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
    let started = Instant::now();
    let generation = model
        .generate(
            &request(prompt, None, 64, &[END_OF_TURN], &already),
            &mut |_| Control::Continue,
        )
        .expect("a cancelled generation is Ok");
    assert_eq!(generation.finish, Finish::Cancelled);
    assert!(generation.text.is_empty());
    assert!(started.elapsed() < Duration::from_secs(1));

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
    let long = format!("<|im_start|>user\n{}<|im_end|>\n", "word ".repeat(2500));
    let error = model
        .generate(
            &request(&long, None, 8, &[END_OF_TURN], &cancel),
            &mut |_| Control::Continue,
        )
        .expect_err("the window is 2048 tokens");
    assert!(
        matches!(
            error,
            centraid_assist::model::ModelError::ContextExceeded { held: 2048, .. }
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
/// `estimate_tokens` is what the budget trusts when it decides whether to drop a
/// turn, a tool or a digest row; an under-count is a prompt the engine then
/// refuses (`ContextExceeded`) after the member waited for it. The table it
/// prints is the one `estimate_tokens`'s documentation quotes.
#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn the_token_estimate_never_undercounts_the_real_tokenizer() {
    use centraid_assist::prompt::{PromptStyle, estimate_tokens, phrase_prompt, route_prompt};

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
            r#"{"tool":"tasks.list","args":{"view":"today"}}"#.repeat(8),
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

    // The plane's own prompts, both styles: every eval route prompt, and a
    // phrase prompt over every canned read.
    for style in [PromptStyle::Stock, PromptStyle::FineTuned] {
        let budget = Budget::DEFAULT.styled(style);
        let mut worst_under = f64::MAX;
        let (mut sum, mut count, mut real_max) = (0.0, 0, 0);
        let mut check = |label: &str, text: &str| {
            let real = real_tokens(&model, text);
            let estimate = estimate_tokens(text);
            assert!(
                estimate >= real,
                "{label}: estimated {estimate}, really {real}"
            );
            let ratio = f64::from(estimate) / f64::from(real);
            worst_under = worst_under.min(ratio);
            sum += ratio;
            count += 1;
            real_max = real_max.max(real);
            assert!(
                real + budget.reserve <= budget.window,
                "{label}: {real} real tokens leave no room for the answer"
            );
        };
        for case in &eval_file().cases {
            check(&case.id, &case.prompt(budget).expect("a prompt").text);
        }
        for (asked, route, output) in ten_reads() {
            let route_prompt = route_prompt(None, &[], asked, budget);
            let call = parse_call(route);
            check(
                asked,
                &phrase_prompt(&route_prompt, &call, &output, budget).text,
            );
        }
        println!(
            "{:<10} {count} prompts: estimate/real min {worst_under:.2}x, mean {:.2}x; longest real prompt {real_max} tokens",
            style.name(),
            sum / f64::from(count)
        );
    }
}

/// The call a canned route spells.
fn parse_call(route: &str) -> centraid_assist::call::ToolCall {
    match centraid_assist::call::parse_route(route, &centraid_assist::ToolSet::for_scope(None))
        .expect("a route")
    {
        centraid_assist::call::Route::Tool(call) => call,
        other => panic!("{other:?}"),
    }
}

// ----------------------------------------------------------------------------
// THE PHRASE STEP, AND SESSIONS, THROUGH THE PRODUCTION `Plane`.
// ----------------------------------------------------------------------------

use centraid_assist::model::{Generation, ModelError};
use centraid_assist::prompt::PromptStyle;
use centraid_assist::result::{Card, ToolOutput};
use centraid_assist::testing::StaticReader;
use centraid_assist::tool::App;
use centraid_assist::turn::{Event, Plane, ReadContext, Session};

/// A model that routes by script and phrases with the real one, so the phrase
/// step is measured through `Plane` — its prompt, its grammar, its fallback —
/// and not through a copy of it.
struct RoutedByScript {
    real: Arc<dyn Model>,
    route: std::sync::Mutex<String>,
}

impl Model for RoutedByScript {
    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        if request
            .grammar
            .is_some_and(|grammar| grammar.starts_with("root ::= call"))
        {
            let text = self.route.lock().unwrap().clone();
            return Ok(Generation {
                text,
                finish: Finish::Stop,
                prompt_tokens: 0,
                generated_tokens: 0,
            });
        }
        self.real.generate(request, on_token)
    }
}

/// Ten reads shaped like the core's own (headline, facts, rows), over the
/// sample vault's weekend.
fn ten_reads() -> Vec<(&'static str, &'static str, ToolOutput)> {
    let task = |id: &str, title: &str, due: &str, meta: &str| {
        Card::new(App::Tasks, "task", id, title)
            .subtitle(due)
            .meta(meta)
    };
    let event = |id: &str, title: &str, when: &str, place: &str| {
        Card::new(App::Agenda, "event", id, title)
            .subtitle(when)
            .meta(place)
    };
    let mut balances = ToolOutput::of_rows(
        "2 friends with a balance",
        vec![
            Card::new(App::Tally, "friend", "p1", "Marco").subtitle("owes you 92.50 USD"),
            Card::new(App::Tally, "friend", "p2", "Ana").subtitle("owes you 47.50 USD"),
        ],
    );
    balances.facts = vec!["Owed to you in total: 140.00 USD".to_owned()];
    let mut spending = ToolOutput {
        headline: "Spending in 2026-09: 1240.50 USD".to_owned(),
        ..ToolOutput::default()
    };
    spending.facts = vec![
        "Lodging: 640.00 USD".to_owned(),
        "Groceries: 312.40 USD".to_owned(),
        "Gas: 143.10 USD".to_owned(),
        "Activities: 145.00 USD".to_owned(),
    ];
    vec![
        (
            "What's due today?",
            r#"{"tool":"tasks.list","args":{"view":"today"}}"#,
            ToolOutput::of_rows(
                "3 tasks due today, 1 overdue",
                vec![
                    task("t1", "Pick up the dry cleaning", "2026-10-01", ""),
                    task("t2", "Book the cabin", "2026-09-29", "overdue"),
                    task("t3", "Rotate the tires", "2026-10-01", ""),
                ],
            ),
        ),
        (
            "What tasks are overdue?",
            r#"{"tool":"tasks.list","args":{"view":"overdue"}}"#,
            ToolOutput::of_rows(
                "1 task overdue",
                vec![task("t2", "Book the cabin", "2026-09-29", "overdue")],
            ),
        ),
        (
            "What does my week look like?",
            r#"{"tool":"agenda.upcoming","args":{"range":"week"}}"#,
            ToolOutput::of_rows(
                "4 events in the next 7 days",
                vec![
                    event("e1", "Dentist", "2026-10-02 09:30", "Main St"),
                    event("e2", "Dinner with Maya", "2026-10-03 19:00", "Osteria"),
                    event("e3", "Tahoe weekend", "2026-10-04", "Lake Tahoe"),
                    event("e4", "Team sync", "2026-10-06 10:00", ""),
                ],
            ),
        ),
        (
            "Who owes me money?",
            r#"{"tool":"tally.balances","args":{}}"#,
            balances,
        ),
        (
            "Show me photos of Ana",
            r#"{"tool":"photos.search","args":{"term":"Ana"}}"#,
            ToolOutput::of_rows(
                "5 photographs matching \"Ana\"",
                vec![
                    Card::new(App::Photos, "photo", "a1", "Ana at the trailhead")
                        .subtitle("2026-09-28")
                        .meta("Tahoe scouting"),
                    Card::new(App::Photos, "photo", "a2", "Ana on the porch")
                        .subtitle("2026-09-27")
                        .meta("Tahoe scouting"),
                ],
            ),
        ),
        (
            "Who should I get in touch with?",
            r#"{"tool":"people.reconnect","args":{}}"#,
            ToolOutput::of_rows(
                "2 people due for a catch-up, 1 date coming up",
                vec![
                    Card::new(App::People, "person", "p1", "Jake").meta("college friend, 90 days"),
                    Card::new(App::People, "person", "p2", "Grandpa Ray").meta("family"),
                    Card::new(App::People, "person", "p3", "Maya")
                        .subtitle("Birthday in 6 days")
                        .meta("friend"),
                ],
            ),
        ),
        (
            "What did we spend last month?",
            r#"{"tool":"tally.spending","args":{"month":"last"}}"#,
            spending,
        ),
        (
            "Find my note on chili",
            r#"{"tool":"notes.search","args":{"term":"chili"}}"#,
            ToolOutput::of_rows(
                "1 note matching \"chili\"",
                vec![
                    Card::new(App::Notes, "note", "n1", "Grandma's chili")
                        .subtitle("2026-08-14")
                        .meta("Recipes"),
                ],
            ),
        ),
        (
            "What's on my calendar tomorrow?",
            r#"{"tool":"agenda.upcoming","args":{"range":"tomorrow"}}"#,
            ToolOutput::of_rows("No events tomorrow", Vec::new()),
        ),
        (
            "Where's my insurance policy?",
            r#"{"tool":"docs.search","args":{"term":"insurance policy"}}"#,
            ToolOutput::of_rows(
                "2 documents matching \"insurance policy\"",
                vec![
                    Card::new(
                        App::Docs,
                        "document",
                        "d1",
                        "Auto insurance policy 2026.pdf",
                    )
                    .subtitle("PDF, 2 MB"),
                    Card::new(App::Docs, "document", "d2", "Renters insurance renewal.pdf")
                        .subtitle("PDF, 310 KB"),
                ],
            ),
        ),
    ]
}

#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn ten_phrase_samples_through_the_plane() {
    let Some(real) = model() else { return };
    let style = std::env::var("CENTRAID_ASSIST_STYLE")
        .ok()
        .and_then(|name| PromptStyle::from_name(&name))
        .unwrap_or(PromptStyle::DEFAULT);
    let budget = Budget::DEFAULT.styled(style);
    println!("style: {}", style.name());
    let (mut meta, mut json, mut empty) = (0, 0, 0);
    for (asked, route, output) in ten_reads() {
        let name = route.split('"').nth(3).unwrap();
        let name: &'static str = centraid_assist::tool::tool(name).unwrap().name;
        let scripted = RoutedByScript {
            real: Arc::clone(&real),
            route: std::sync::Mutex::new(route.to_owned()),
        };
        let reader = StaticReader::new().with(name, output.clone());
        let plane = Plane {
            model: &scripted,
            reader: &reader,
            budget,
        };
        let mut raw = String::new();
        let answered = plane
            .run_turn(
                &mut Session::new(None),
                asked,
                &ReadContext { tz: "UTC" },
                &Cancel::new(),
                &mut |event| {
                    if let Event::Token(piece) = event {
                        raw.push_str(&piece);
                    }
                },
            )
            .expect("the turn answers");
        let lower = raw.to_lowercase();
        let is_meta = [
            "the user",
            "the data",
            "tool_response",
            "result shows",
            "the tool",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
        meta += usize::from(is_meta);
        json += usize::from(raw.trim_start().starts_with('{'));
        empty += usize::from(raw.trim().is_empty());
        println!(
            "Q: {asked}\n   model : {raw:?}{}\n   shown : {:?}",
            if is_meta { "  <-- meta" } else { "" },
            answered.text
        );
    }
    println!("summary: json-first {json}/10, meta-commentary {meta}/10, empty {empty}/10");
}
