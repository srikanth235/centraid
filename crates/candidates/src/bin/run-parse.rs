//! `run-parse` — score the tier-D parser against the frozen corpora.
//!
//!     cargo run --bin run-parse -- --corpus suite|blind|holdout|all
//!     cargo run --bin run-parse -- --registers
//!
//! No vault is opened and no model is loaded: this measures PARAPHRASE only,
//! which is the half of the problem a candidate has to solve before its
//! executor matters.

use centraid_candidates::parse::score::{
    Row, Tally, overall, parse_corpus, parse_registers, score, tally_by,
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut corpora: Vec<String> = Vec::new();
    let mut registers = false;
    let mut show_failures = true;
    // A SKELETON row is the shape right and the literal wrong: the failure
    // that costs a candidate every row it returns while looking like a pass.
    let mut show_literals = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--corpus" => {
                index += 1;
                let name = args.get(index).cloned().unwrap_or_else(|| "suite".into());
                if name == "all" {
                    corpora.extend(["suite".into(), "blind".into(), "holdout".into()]);
                } else if name == "registers" {
                    // The registers are not a corpus of map.json: they are 349
                    // paraphrases scored against the BASE turn's gold, and
                    // `parse_corpus` filters map.json by corpus name, so this
                    // spelling used to report 0 turns scored rather than an
                    // error. It now means what a reader means by it.
                    registers = true;
                } else {
                    corpora.push(name);
                }
            }
            "--registers" => registers = true,
            "--quiet" => show_failures = false,
            "--literals" => show_literals = true,
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
        index += 1;
    }
    if corpora.is_empty() && !registers {
        corpora.push("suite".into());
    }

    for corpus in &corpora {
        let rows = score(&parse_corpus(corpus));
        report(
            &format!("corpus {corpus}"),
            &rows,
            |row| row.category.clone(),
            "category",
        );
        let moves = tally_by(&rows, |row| row.context_move.clone());
        table("context move", &moves);
        if show_failures {
            failures(&rows);
        }
        if show_literals {
            literals(&rows);
        }
    }

    if registers {
        let rows = score(&parse_registers());
        report("registers", &rows, |row| row.register.clone(), "register");
        if show_failures {
            failures(&rows);
        }
    }
}

fn report(title: &str, rows: &[Row], key: impl Fn(&Row) -> String, key_name: &str) {
    let total = overall(rows);
    println!("\n=== {title} ===");
    println!(
        "turns {:>4}   scored {:>4}   exact {:>4} ({:>5.1}%)   skeleton+ {:>4} ({:>5.1}%)   \
wrong {:>4}   unparsed {:>4}   ILLEGAL {}",
        rows.len(),
        total.scored(),
        total.exact,
        100.0 * total.exact_rate(),
        total.exact + total.skeleton,
        100.0 * total.skeleton_rate(),
        total.wrong,
        total.unparsed,
        total.illegal,
    );
    let grouped = tally_by(rows, key);
    table(key_name, &grouped);
}

fn table(name: &str, grouped: &std::collections::BTreeMap<String, Tally>) {
    println!(
        "\n  {:<24} {:>5} {:>7} {:>9} {:>7} {:>9}",
        name, "n", "exact", "skeleton+", "wrong", "unparsed"
    );
    for (label, tally) in grouped {
        if Tally::scored(tally) == 0 {
            continue;
        }
        println!(
            "  {:<24} {:>5} {:>7} {:>8.0}% {:>7} {:>9}",
            label,
            tally.scored(),
            tally.exact,
            100.0 * tally.skeleton_rate(),
            tally.wrong,
            tally.unparsed,
        );
    }
}

/// The rows whose SHAPE is right and whose literal is not.
fn literals(rows: &[Row]) {
    println!("\n  --- skeleton: the shape is right, the literal is not ---");
    for row in rows {
        if row.verdict != "skeleton" {
            continue;
        }
        println!("  [skeleton] {} | {}", row.id, row.request);
        println!("      gold: {}", row.gold);
        println!("      mine: {}", row.mine.as_deref().unwrap_or(""));
    }
}

fn failures(rows: &[Row]) {
    println!("\n  --- wrong and unparsed, with the gold beside them ---");
    for row in rows {
        if !matches!(row.verdict.as_str(), "wrong" | "unparsed" | "illegal") {
            continue;
        }
        println!("  [{}] {} | {}", row.verdict, row.id, row.request);
        println!("      gold: {}", row.gold);
        match &row.mine {
            Some(text) => println!("      mine: {text}"),
            None => println!("      mine: (abstained) {}", row.why),
        }
    }
}
