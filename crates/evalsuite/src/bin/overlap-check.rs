//! # `overlap-check` — the method rule, made mechanical
//!
//! ```text
//! cargo run -p centraid-evalsuite --bin overlap-check -- <train.jsonl> [<val.jsonl> ...]
//! ```
//!
//! **"Training data must never see the suite" was a rule with nothing behind
//! it** (review item B12). A corpus that has leaked into training measures
//! memorisation and reports it as competence, and the leak is invisible in
//! every number the harness prints — the scores go UP.
//!
//! Four questions, asked of a JSONL training file (one object per line, a
//! `request` field and an optional `template_id`) against both corpora:
//!
//! 1. **Exact request collisions** — the same sentence, normalised for case,
//!    punctuation and spacing. A corpus request a model was trained on is not
//!    evidence about anything. **Fails the run.**
//! 2. **Four-gram collisions** — a shared run of four words. Not fatal on its
//!    own: "what did I spend last month" is how the language works, and a
//!    corpus written in a member's own words will share phrasing with training
//!    data written in the same words. It is reported as a RATE, because the
//!    rate is what tells ordinary English from a paraphrase of the corpus.
//! 3. **Proper-noun leaks** — the names and places the corpora are built on
//!    (`Neha Rao`, `Emerald Bay`, `Tahoe Trip`) appearing in training
//!    requests. This is the one that quietly destroys a held-out set: a model
//!    that has seen the vault's cast can resolve an anchor without retrieving
//!    anything. Reported, never fatal by itself — the same first names occur
//!    in ordinary sentences.
//! 4. **Shared template ids** — a `template_id` present in both the training
//!    file and a validation file passed on the command line. Holding out
//!    WORDING while training on the TEMPLATE is not holding anything out.
//!    **Fails the run.**
//!
//! It never edits anything. A leak is a fact about the data, and the fix
//! belongs to whoever owns the data.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Case, punctuation and spacing folded away — the form two sentences are
/// "the same sentence" in.
fn normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for character in text.chars() {
        if character.is_alphanumeric() {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.extend(character.to_lowercase());
        } else {
            space = true;
        }
    }
    out
}

fn words(text: &str) -> Vec<String> {
    normalise(text)
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// Every four-word run. Shorter sentences contribute nothing, which is
/// correct: "how much?" is not evidence of a leak.
fn four_grams(text: &str) -> BTreeSet<String> {
    let words = words(text);
    words.windows(4).map(|run| run.join(" ")).collect()
}

/// THE PROPER NOUNS A CORPUS IS BUILT ON.
///
/// Capitalised words that are not the first word of the sentence and are not
/// ordinary sentence-initial capitals — plus every capitalised word of every
/// stable handle's label, which is where the cast actually lives. A stop list
/// keeps the days and months out: "Friday" is a leak of nothing.
fn proper_nouns(text: &str) -> BTreeSet<String> {
    const NOT_A_NAME: &[&str] = &[
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january",
        "february", "march", "april", "may", "june", "july", "august", "september", "october",
        "november", "december", "i", "i'm", "i've", "the",
    ];
    let mut found = BTreeSet::new();
    for (index, word) in text.split_whitespace().enumerate() {
        let trimmed: String = word
            .chars()
            .filter(|character| character.is_alphanumeric() || *character == '\'')
            .collect();
        if trimmed.len() < 3 || index == 0 {
            continue;
        }
        if NOT_A_NAME.contains(&trimmed.to_lowercase().as_str()) {
            continue;
        }
        if trimmed
            .chars()
            .next()
            .is_some_and(char::is_uppercase)
        {
            found.insert(trimmed.to_lowercase());
        }
    }
    found
}

struct Corpus {
    name: String,
    requests: Vec<(String, String)>,
    /// Proper nouns, from the requests AND from the handle labels.
    names: BTreeSet<String>,
}

fn read_corpus(path: &Path) -> Result<Corpus, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut requests = Vec::new();
    let mut names = BTreeSet::new();
    if let Some(handles) = json.get("handles").and_then(serde_json::Value::as_object) {
        for spec in handles.values() {
            if let Some(label) = spec.get("label").and_then(serde_json::Value::as_str) {
                // A LABEL'S FIRST WORD IS NOT A NAME. Handle labels are
                // titles — "Call Ray Okafor", "Book the Donner lodge
                // viewing" — and taking their opening capital would put
                // `call` and `book` in the cast and report ordinary English
                // as a leak.
                names.extend(proper_nouns(label));
            }
        }
    }
    for session in json
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| format!("{}: no sessions", path.display()))?
    {
        let id = session
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("?")
            .to_owned();
        for (index, turn) in session
            .get("turns")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(request) = turn.get("request").and_then(serde_json::Value::as_str) {
                names.extend(proper_nouns(request));
                requests.push((format!("{id}/t{}", index + 1), request.to_owned()));
            }
        }
    }
    Ok(Corpus {
        name: path
            .file_name()
            .map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned()),
        requests,
        names,
    })
}

struct Rows {
    requests: Vec<String>,
    templates: BTreeSet<String>,
}

fn read_jsonl(path: &Path) -> Result<Rows, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut requests = Vec::new();
    let mut templates = BTreeSet::new();
    for (number, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row: serde_json::Value = serde_json::from_str(line)
            .map_err(|error| format!("{}:{}: {error}", path.display(), number + 1))?;
        if let Some(request) = row.get("request").and_then(serde_json::Value::as_str) {
            requests.push(request.to_owned());
        }
        if let Some(template) = row.get("template_id").and_then(serde_json::Value::as_str) {
            templates.insert(template.to_owned());
        }
    }
    Ok(Rows {
        requests,
        templates,
    })
}

#[expect(clippy::too_many_lines, reason = "one report, printed in one place")]
fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(training) = args.next() else {
        eprintln!(
            "usage: overlap-check <train.jsonl> [<val.jsonl> ...]\n\
             the two corpora are read from this crate's suite.json and blind.json"
        );
        return ExitCode::FAILURE;
    };
    let training_path = PathBuf::from(&training);
    let validation: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    let train = match read_jsonl(&training_path) {
        Ok(rows) => rows,
        Err(why) => {
            eprintln!("{why}");
            return ExitCode::FAILURE;
        }
    };
    let corpora: Vec<Corpus> = match ["suite.json", "blind.json"]
        .iter()
        .map(|name| read_corpus(&here.join(name)))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(corpora) => corpora,
        Err(why) => {
            eprintln!("{why}");
            return ExitCode::FAILURE;
        }
    };

    println!(
        "training {} — {} request(s), {} template(s)",
        training_path.display(),
        train.requests.len(),
        train.templates.len()
    );

    // The training side, indexed once.
    let exact: BTreeSet<String> = train.requests.iter().map(|text| normalise(text)).collect();
    let mut grams: BTreeMap<String, usize> = BTreeMap::new();
    let mut training_words: BTreeSet<String> = BTreeSet::new();
    for request in &train.requests {
        for gram in four_grams(request) {
            *grams.entry(gram).or_default() += 1;
        }
        training_words.extend(words(request));
    }

    let mut fatal = 0usize;
    for corpus in &corpora {
        println!("\n== {} — {} request(s) ==", corpus.name, corpus.requests.len());

        // 1. EXACT COLLISIONS. Fatal.
        let collisions: Vec<&(String, String)> = corpus
            .requests
            .iter()
            .filter(|(_, request)| exact.contains(&normalise(request)))
            .collect();
        println!("  exact request collisions: {}", collisions.len());
        for (key, request) in &collisions {
            println!("    {key} {request:?}");
        }
        fatal += collisions.len();

        // 2. FOUR-GRAM COLLISIONS. A rate, not a verdict.
        let mut shared_requests = 0usize;
        let mut shared_grams: BTreeSet<String> = BTreeSet::new();
        let mut worst: Vec<(usize, String, String)> = Vec::new();
        for (key, request) in &corpus.requests {
            let mine = four_grams(request);
            let hit: BTreeSet<String> = mine
                .iter()
                .filter(|gram| grams.contains_key(*gram))
                .cloned()
                .collect();
            if !hit.is_empty() {
                shared_requests += 1;
                worst.push((hit.len(), key.clone(), request.clone()));
                shared_grams.extend(hit);
            }
        }
        #[expect(clippy::cast_precision_loss, reason = "a rate over a corpus of tens")]
        let rate = shared_requests as f64 * 100.0 / corpus.requests.len().max(1) as f64;
        println!(
            "  4-gram collisions: {shared_requests} of {} request(s) ({rate:.1}%), \
             {} distinct 4-gram(s)",
            corpus.requests.len(),
            shared_grams.len()
        );
        worst.sort_by(|left, right| right.0.cmp(&left.0));
        for (count, key, request) in worst.iter().take(5) {
            println!("    {key} shares {count} 4-gram(s): {request:?}");
        }

        // 3. PROPER-NOUN LEAKS.
        let leaked: Vec<&String> = corpus
            .names
            .iter()
            .filter(|name| training_words.contains(*name))
            .collect();
        #[expect(clippy::cast_precision_loss, reason = "a rate over a cast of dozens")]
        let leak_rate = leaked.len() as f64 * 100.0 / corpus.names.len().max(1) as f64;
        println!(
            "  proper-noun leaks: {} of {} name(s) in this corpus appear in training ({leak_rate:.1}%)",
            leaked.len(),
            corpus.names.len()
        );
        println!(
            "    {}",
            leaked
                .iter()
                .take(30)
                .map(|name| name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    // 4. SHARED TEMPLATES, against every validation file passed. Fatal.
    let mut shared_templates = 0usize;
    for path in &validation {
        match read_jsonl(path) {
            Err(why) => {
                eprintln!("{why}");
                return ExitCode::FAILURE;
            }
            Ok(rows) => {
                let shared: Vec<&String> = rows
                    .templates
                    .iter()
                    .filter(|template| train.templates.contains(*template))
                    .collect();
                println!(
                    "\n== {} — {} row(s), {} template(s) ==",
                    path.display(),
                    rows.requests.len(),
                    rows.templates.len()
                );
                let shared_exact = rows
                    .requests
                    .iter()
                    .filter(|request| exact.contains(&normalise(request)))
                    .count();
                println!("  exact requests shared with training: {shared_exact}");
                println!(
                    "  TEMPLATES SHARED WITH TRAINING: {} of {}",
                    shared.len(),
                    rows.templates.len()
                );
                for template in shared.iter().take(40) {
                    println!("    {template}");
                }
                if shared.len() > 40 {
                    println!("    … and {} more", shared.len() - 40);
                }
                shared_templates += shared.len();
            }
        }
    }

    println!(
        "\nWhat is FATAL here: an exact request collision, and a template shared between\n\
         training and a validation file. Everything else is reported and judged by a\n\
         person: a 4-gram rate is partly just English, and a first name is partly just a\n\
         first name — but a corpus whose whole cast is in the training data is not held\n\
         out, whatever the rate says."
    );

    if fatal == 0 && shared_templates == 0 {
        println!("\nNo exact collision and no shared template.");
        return ExitCode::SUCCESS;
    }
    println!(
        "\nFAIL — {fatal} exact request collision(s), {shared_templates} shared template(s)."
    );
    ExitCode::FAILURE
}
