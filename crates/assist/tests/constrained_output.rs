//! CONSTRAINED OUTPUT (#1188): the phone holds the think to a grammar, and a token stream that
//! would write an invalid call cannot get it out, while a valid one comes through unchanged. The
//! stream here is scripted: a model that offers candidate completions and, like the engine under a
//! grammar, emits only one the grammar derives.

use centraid_assist::model::{Control, Finish, GenerateRequest, Generation, Model, ModelError};
use centraid_assist::native::grammar::{GrammarMode, Visible, full_ending, grammar_for_step};
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist::native_turn::NativePlane;
use centraid_assist::testing::ScriptedModel;

const END: &str = "";
const VIA: &[&str] = &["find", "search", "open", "compute"];

/// The handles a think names are shown: what a prompt that led to it would show.
fn showing(think: &str) -> Visible {
    let mut seen = Visible::of(think, None, None);
    let mut rest = think;
    while let Some(at) = rest.find("dates[") {
        rest = &rest[at + 6..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(number) = digits.parse::<usize>() {
            seen.dates = seen.dates.max(number + 1);
        }
    }
    seen
}

fn finished(think: &str) -> String {
    format!("{think}\n")
}

fn goldens() -> Vec<String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../nativetools/tests/golden_v3.json"
    );
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    rows.iter()
        .filter_map(|row| row["think4"].as_str().map(str::to_owned))
        .collect()
}

/// Offers its candidates in order; under a grammar it emits the first one the grammar derives and
/// nothing when none is derivable.
struct Stream {
    candidates: Vec<String>,
    accepts: Box<dyn Fn(&str) -> bool + Send + Sync>,
}

impl Model for Stream {
    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        let allowed = |text: &&String| request.grammar.is_none() || (self.accepts)(text);
        let text = self
            .candidates
            .iter()
            .find(allowed)
            .cloned()
            .unwrap_or_default();
        let _ = on_token(&text);
        Ok(Generation {
            generated_tokens: 1,
            prompt_tokens: 0,
            finish: Finish::Stop,
            text,
        })
    }
}

#[test]
fn the_phone_holds_the_think_to_the_strongest_grammar_its_tools_have() {
    let model = ScriptedModel::new([""]);
    let options = NativePlane::new(&model).options;
    assert_eq!(options.grammar, GrammarMode::Full);
    let record = centraid_assist::record::record();
    assert_eq!(options.tools.name(), record.current.tools_mode);
    // the mode in effect: the full grammar for the regrouped tools, the handles rule for S2's
    let (mode, gbnf) = grammar_for_step(options.grammar, options.tools, &Visible::default(), "")
        .expect("a grammar");
    let expected = if options.tools == ToolsMode::S2 {
        GrammarMode::Handles
    } else {
        GrammarMode::Full
    };
    assert_eq!(mode, expected);
    assert!(!gbnf.is_empty());
}

#[test]
fn an_invalid_call_cannot_be_emitted_and_a_valid_one_is_unchanged() {
    // a think of the training set that names a row, and the same think naming a row the prompt does
    // not show
    let valid = goldens()
        .into_iter()
        .find(|think| {
            think.contains('#')
                && full_ending(&showing(think), false, VIA, END).accepts(&finished(think))
        })
        .expect("a golden think the full grammar derives");
    let valid = finished(&valid);
    let seen = showing(&valid);
    let hidden = seen.rows.iter().max().unwrap() + 100;
    let handle = format!("#{}", seen.rows.iter().next().unwrap());
    let invalid = valid.replace(&handle, &format!("#{hidden}"));
    assert_ne!(invalid, valid);

    let grammar = full_ending(&seen, false, VIA, END);
    assert!(grammar.accepts(&valid));
    assert!(
        !grammar.accepts(&invalid),
        "a handle the prompt does not show is not derivable"
    );

    let under = |candidates: Vec<String>| {
        let grammar = full_ending(&seen, false, VIA, END);
        let model = Stream {
            candidates,
            accepts: Box::new(move |text| grammar.accepts(text)),
        };
        let gbnf = full_ending(&seen, false, VIA, END).to_gbnf();
        let mut out = String::new();
        model
            .generate(
                &GenerateRequest {
                    prompt: "",
                    grammar: Some(&gbnf),
                    max_tokens: 256,
                    stop: &[],
                    temperature: 0.0,
                    cancel: &centraid_assist::model::Cancel::new(),
                    images: &[],
                },
                &mut |piece| {
                    out.push_str(piece);
                    Control::Continue
                },
            )
            .unwrap();
        out
    };
    // the invalid one is offered first and is not the one that comes out
    assert_eq!(under(vec![invalid.clone(), valid.clone()]), valid);
    // a valid one alone is unchanged
    assert_eq!(under(vec![valid.clone()]), valid);
    // nothing derivable: nothing is emitted
    assert_eq!(under(vec![invalid]), "");
}
