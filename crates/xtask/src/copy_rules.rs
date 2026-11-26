use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

use crate::rules::RuleReport;

const CATALOG_DIR: &str = "crates/screens/src/strings";
const COPY_DIR: &str = "copy";
pub const BUDGET_PATH: &str = "crates/xtask/copy-budget.toml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyFinding {
    pub file: String,
    pub key: String,
    pub rule: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetDelta {
    pub rule: String,
    pub file: String,
    pub count: usize,
    pub budget: usize,
}

pub type BudgetMap = BTreeMap<String, BTreeMap<String, usize>>;

pub struct CopyMeasure {
    pub measured: BudgetMap,
    pub findings: Vec<CopyFinding>,
    pub missing: Vec<String>,
    pub scanned: usize,
}

pub struct CopyCheck {
    pub missing: Vec<String>,
    pub measured: BudgetMap,
    pub findings: Vec<CopyFinding>,
    pub over: Vec<BudgetDelta>,
    pub under: Vec<BudgetDelta>,
    pub scanned: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WordCap {
    pub kind: &'static str,
    pub max: usize,
}

pub fn load_budget(root: &Path) -> Result<BudgetMap> {
    let path = root.join(BUDGET_PATH);
    let text = fs::read_to_string(&path).with_context(|| format!("read {BUDGET_PATH}"))?;
    parse_budget_toml(&text)
}

pub fn parse_budget_toml(text: &str) -> Result<BudgetMap> {
    toml::from_str(text).context("parse copy-budget.toml")
}

pub fn format_budget_toml(measured: &BudgetMap) -> String {
    let mut out = String::new();
    for (rule, files) in measured {
        if files.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("[{rule}]\n"));
        for (file, count) in files {
            out.push_str(&format!("\"{file}\" = {count}\n"));
        }
    }
    out
}

pub fn unescape_rust(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('u') if chars.peek() == Some(&'{') => {
                chars.next();
                let mut hex = String::new();
                while let Some(&h) = chars.peek() {
                    chars.next();
                    if h == '}' {
                        break;
                    }
                    hex.push(h);
                }
                if let Ok(code) = u32::from_str_radix(&hex, 16)
                    && let Some(ch) = char::from_u32(code)
                {
                    out.push(ch);
                }
            }
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

pub fn catalog_strings(source: &str) -> BTreeMap<String, [String; 2]> {
    let mut out = BTreeMap::new();
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if let Some(body_start) = match_catalog_open(source, i) {
            let mut depth = 1usize;
            let mut at = body_start;
            let mut in_string = false;
            while at < bytes.len() && depth > 0 {
                let b = bytes[at];
                if in_string {
                    if b == b'\\' {
                        at += 2;
                        continue;
                    } else if b == b'"' {
                        in_string = false;
                    }
                } else if b == b'"' {
                    in_string = true;
                } else if b == b'{' {
                    depth += 1;
                } else if b == b'}' {
                    depth -= 1;
                }
                at += 1;
            }
            let body_end = at.saturating_sub(1).max(body_start);
            parse_catalog_body(&source[body_start..body_end], &mut out);
            i = at;
        } else {
            i += 1;
        }
    }
    out
}

fn match_catalog_open(source: &str, start: usize) -> Option<usize> {
    if !source.is_char_boundary(start) {
        return None;
    }
    if start > 0 {
        let prev = source[..start].chars().next_back()?;
        if prev.is_ascii_alphanumeric() || prev == '_' {
            return None;
        }
    }
    let rest = source.get(start..)?;
    let after = rest.strip_prefix("catalog!")?;
    let trimmed = after.trim_start();
    let after_brace = trimmed.strip_prefix('{')?;
    let consumed = rest.len() - after_brace.len();
    Some(start + consumed)
}

fn parse_catalog_body(body: &str, out: &mut BTreeMap<String, [String; 2]>) {
    let mut i = 0;
    let bytes = body.as_bytes();
    while i < bytes.len() {
        let keyword = if starts_with_word(body, i, "plain") {
            Some(5)
        } else if starts_with_word(body, i, "counted") {
            Some(7)
        } else {
            None
        };
        let Some(kw_len) = keyword else {
            i += 1;
            continue;
        };
        let mut cursor = skip_ws(body, i + kw_len);
        let name_start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_lowercase()
                || bytes[cursor].is_ascii_digit()
                || bytes[cursor] == b'_')
        {
            cursor += 1;
        }
        if cursor == name_start {
            i += kw_len;
            continue;
        }
        let name = &body[name_start..cursor];
        cursor = skip_ws(body, cursor);
        if bytes.get(cursor) != Some(&b'=') {
            i += kw_len;
            continue;
        }
        cursor = skip_ws(body, cursor + 1);
        if bytes.get(cursor) != Some(&b'(') {
            i += kw_len;
            continue;
        }
        cursor = skip_ws(body, cursor + 1);
        let Some((first, next)) = read_string_literal(body, cursor) else {
            i += kw_len;
            continue;
        };
        cursor = skip_ws(body, next);
        if bytes.get(cursor) != Some(&b',') {
            i += kw_len;
            continue;
        }
        cursor = skip_ws(body, cursor + 1);
        let Some((second, next)) = read_string_literal(body, cursor) else {
            i += kw_len;
            continue;
        };
        cursor = skip_ws(body, next);
        if bytes.get(cursor) == Some(&b',') {
            cursor = skip_ws(body, cursor + 1);
        }
        if bytes.get(cursor) != Some(&b')') {
            i += kw_len;
            continue;
        }
        cursor = skip_ws(body, cursor + 1);
        if bytes.get(cursor) != Some(&b';') {
            i += kw_len;
            continue;
        }
        out.insert(
            name.to_ascii_uppercase(),
            [unescape_rust(first), unescape_rust(second)],
        );
        i = cursor + 1;
    }
}

fn starts_with_word(text: &str, idx: usize, word: &str) -> bool {
    if !text.is_char_boundary(idx) {
        return false;
    }
    if idx > 0 {
        let prev = text.as_bytes()[idx - 1];
        if prev.is_ascii_alphanumeric() || prev == b'_' {
            return false;
        }
    }
    let Some(after) = text[idx..].strip_prefix(word) else {
        return false;
    };
    match after.as_bytes().first() {
        Some(&b) => !(b.is_ascii_alphanumeric() || b == b'_'),
        None => true,
    }
}

fn skip_ws(text: &str, mut idx: usize) -> usize {
    let bytes = text.as_bytes();
    while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
        idx += 1;
    }
    idx
}

fn read_string_literal(text: &str, start: usize) -> Option<(&str, usize)> {
    let bytes = text.as_bytes();
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
        } else if bytes[i] == b'"' {
            return Some((&text[start + 1..i], i + 1));
        } else {
            i += 1;
        }
    }
    None
}

pub fn word_count(value: &str) -> usize {
    value
        .split_whitespace()
        .filter(|token| token.chars().any(char::is_alphanumeric))
        .count()
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn has_word_phrase(lower: &str, phrase: &str) -> bool {
    let mut from = 0;
    while let Some(pos) = lower[from..].find(phrase) {
        let abs = from + pos;
        let end = abs + phrase.len();
        let before_ok = lower[..abs]
            .chars()
            .next_back()
            .is_none_or(|c| !is_word_char(c));
        let after_ok = lower[end..].chars().next().is_none_or(|c| !is_word_char(c));
        if before_ok && after_ok {
            return true;
        }
        from = abs + 1;
        while from < lower.len() && !lower.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

fn has_you_can(lower: &str) -> bool {
    let phrase = "you can";
    let mut from = 0;
    while let Some(pos) = lower[from..].find(phrase) {
        let abs = from + pos;
        let end = abs + phrase.len();
        let before_ok = lower[..abs]
            .chars()
            .next_back()
            .is_none_or(|c| !is_word_char(c));
        let after = &lower[end..];
        let after_ok = after.chars().next().is_none_or(|c| !is_word_char(c))
            && !after.starts_with("'t")
            && !after.starts_with("’t");
        if before_ok && after_ok {
            return true;
        }
        from = abs + 1;
        while from < lower.len() && !lower.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

fn has_core_dot(lower: &str) -> bool {
    let needle = "core.";
    let mut from = 0;
    while let Some(pos) = lower[from..].find(needle) {
        let abs = from + pos;
        let end = abs + needle.len();
        let before_ok = lower[..abs]
            .chars()
            .next_back()
            .is_none_or(|c| !is_word_char(c));
        let after_ok = lower[end..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_');
        if before_ok && after_ok {
            return true;
        }
        from = abs + 1;
        while from < lower.len() && !lower.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

fn strip_quoted_gateway_commands(value: &str) -> String {
    let open_quotes = ['“', '"', '`', '‘', '\''];
    let close_quotes = ['”', '"', '`', '’', '\''];
    let chars: Vec<(usize, char)> = value.char_indices().collect();
    let mut out = String::with_capacity(value.len());
    let mut idx = 0;
    while idx < chars.len() {
        let (byte_pos, ch) = chars[idx];
        if open_quotes.contains(&ch) {
            let mut end_idx = idx + 1;
            while end_idx < chars.len() && !close_quotes.contains(&chars[end_idx].1) {
                end_idx += 1;
            }
            if end_idx < chars.len() {
                let inner_start = byte_pos + ch.len_utf8();
                let inner_end = chars[end_idx].0;
                let inner = &value[inner_start..inner_end];
                if inner.to_ascii_lowercase().contains("centraid-gateway") {
                    out.push(' ');
                    idx = end_idx + 1;
                    continue;
                }
            }
        }
        out.push(ch);
        idx += 1;
    }
    out
}

pub fn banned_in(key: &str, value: &str) -> Vec<&'static str> {
    let lower = value.to_lowercase();
    let mut hits = Vec::new();
    let plain_words: &[(&str, &[&str])] = &[
        ("please", &["please"]),
        ("successfully", &["successfully"]),
        ("simply", &["simply"]),
        ("in order to", &["in order to"]),
    ];
    for &(name, variants) in plain_words {
        if variants.iter().any(|v| has_word_phrase(&lower, v)) {
            hits.push(name);
        }
    }
    if has_you_can(&lower) {
        hits.push("you can");
    }
    if has_word_phrase(&lower, "we're sorry") || has_word_phrase(&lower, "we’re sorry") {
        hits.push("we're sorry");
    }
    let jargon: &[(&str, &[&str])] = &[
        (
            "seal",
            &[
                "seal",
                "seals",
                "sealed",
                "sealing",
                "unseal",
                "unseals",
                "unsealed",
                "unsealing",
            ],
        ),
        ("receipt", &["receipt", "receipts"]),
        ("ledger", &["ledger", "ledgers"]),
        ("drain", &["drain", "drains", "drained", "draining"]),
        ("derived", &["derived"]),
        ("in memory", &["in memory"]),
        ("at rest", &["at rest"]),
        ("by design", &["by design"]),
    ];
    for &(name, variants) in jargon {
        if variants.iter().any(|v| has_word_phrase(&lower, v)) {
            hits.push(name);
        }
    }
    if has_core_dot(&lower) {
        hits.push("core.");
    }
    if has_word_phrase(&lower, "photograph") || has_word_phrase(&lower, "photographs") {
        hits.push("photograph");
    }
    if has_word_phrase(&lower, "this device") {
        hits.push("this device");
    }
    let without_cmd = strip_quoted_gateway_commands(value).to_lowercase();
    if has_word_phrase(&without_cmd, "gateway") || has_word_phrase(&without_cmd, "gateways") {
        hits.push("gateway");
    }
    let words_key = ["WORD", "TYPE", "ENTER", "COUNT"]
        .iter()
        .any(|part| key.contains(part));
    if has_word_phrase(&lower, "24 words") && !words_key && !has_word_phrase(&lower, "recovery key")
    {
        hits.push("24 words");
    }
    hits
}

fn has_suffix_token(key: &str, suffixes: &[&str]) -> bool {
    suffixes
        .iter()
        .any(|s| key == *s || key.ends_with(&format!("_{s}")))
}

pub fn cap_for(key: &str) -> Option<WordCap> {
    if has_suffix_token(
        key,
        &[
            "LABEL",
            "ACTION",
            "PRIMARY",
            "SECONDARY",
            "BUTTON",
            "COMMIT",
            "VERB",
        ],
    ) {
        return Some(WordCap {
            kind: "action",
            max: 4,
        });
    }
    if has_suffix_token(key, &["NOTE", "DETAIL", "LEDE", "STATUS", "HINT"]) {
        return Some(WordCap {
            kind: "note",
            max: 12,
        });
    }
    if has_suffix_token(key, &["BODY", "LEAD", "NOTICE"]) {
        return Some(WordCap {
            kind: "body",
            max: 25,
        });
    }
    if has_suffix_token(key, &["FAILED", "ERROR", "REFUSED", "DENIED"]) {
        return Some(WordCap {
            kind: "error",
            max: 25,
        });
    }
    if has_suffix_token(key, &["TITLE", "HEADLINE"]) {
        return Some(WordCap {
            kind: "title",
            max: 6,
        });
    }
    None
}

pub fn lint_string(key: &str, value: &str) -> Vec<(&'static str, String)> {
    let mut findings = Vec::new();
    let banned = banned_in(key, value);
    if !banned.is_empty() {
        findings.push(("copy-banned-word", banned.join(", ")));
    }
    let words = word_count(value);
    if value.contains(" · ") && words > 6 {
        findings.push(("copy-dot-join", format!("{words} words")));
    }
    if let Some(cap) = cap_for(key)
        && words > cap.max
    {
        findings.push((
            "copy-over-budget",
            format!("{words} words, {} cap {}", cap.kind, cap.max),
        ));
    }
    findings
}

pub fn scan_catalog(file: &str, source: &str) -> Vec<CopyFinding> {
    let mut out = Vec::new();
    for (key, forms) in catalog_strings(source) {
        let mut seen: BTreeMap<&'static str, String> = BTreeMap::new();
        for form in &forms {
            for (rule, detail) in lint_string(&key, form) {
                seen.entry(rule).or_insert(detail);
            }
        }
        for (rule, detail) in seen {
            out.push(CopyFinding {
                file: file.to_owned(),
                key: key.clone(),
                rule,
                detail,
            });
        }
    }
    out
}

pub fn scan_strings_json(
    file: &str,
    strings: &serde_json::Map<String, serde_json::Value>,
) -> Vec<CopyFinding> {
    let mut out = Vec::new();
    for (key, value) in strings {
        let Some(text) = value.as_str() else {
            continue;
        };
        for (rule, detail) in lint_string(key, text) {
            out.push(CopyFinding {
                file: file.to_owned(),
                key: key.clone(),
                rule,
                detail,
            });
        }
    }
    out
}

pub fn measure(root: &Path) -> Result<CopyMeasure> {
    let mut measured: BudgetMap = BTreeMap::new();
    let mut findings = Vec::new();
    let mut missing = Vec::new();
    let mut scanned = 0usize;

    let mut record = |found: Vec<CopyFinding>| {
        for f in found {
            *measured
                .entry(f.rule.to_owned())
                .or_default()
                .entry(f.file.clone())
                .or_insert(0) += 1;
            findings.push(f);
        }
    };

    let catalog = root.join(CATALOG_DIR);
    if catalog.is_dir() {
        let mut names: Vec<String> = fs::read_dir(&catalog)?
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".rs"))
            .collect();
        names.sort();
        for name in names {
            let rel = format!("{CATALOG_DIR}/{name}");
            let src =
                fs::read_to_string(catalog.join(&name)).with_context(|| format!("read {rel}"))?;
            scanned += 1;
            record(scan_catalog(&rel, &src));
        }
    } else {
        missing.push(CATALOG_DIR.to_owned());
    }

    let copy_dir = root.join(COPY_DIR);
    if copy_dir.is_dir() {
        let mut names: Vec<String> = fs::read_dir(&copy_dir)?
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        for name in names {
            let rel = format!("{COPY_DIR}/{name}");
            let src =
                fs::read_to_string(copy_dir.join(&name)).with_context(|| format!("read {rel}"))?;
            let doc: serde_json::Value =
                serde_json::from_str(&src).with_context(|| format!("parse {rel}"))?;
            scanned += 1;
            if let Some(strings) = doc.get("strings").and_then(|v| v.as_object()) {
                record(scan_strings_json(&rel, strings));
            }
        }
    } else {
        missing.push(COPY_DIR.to_owned());
    }

    Ok(CopyMeasure {
        measured,
        findings,
        missing,
        scanned,
    })
}

pub fn compare_budget(
    measured: &BudgetMap,
    budget: &BudgetMap,
) -> (Vec<BudgetDelta>, Vec<BudgetDelta>) {
    let mut over = Vec::new();
    let mut under = Vec::new();
    let rules: BTreeSet<&str> = measured
        .keys()
        .chain(budget.keys())
        .map(String::as_str)
        .collect();
    for rule in rules {
        let have = measured.get(rule);
        let allowed = budget.get(rule);
        let files: BTreeSet<&str> = have
            .into_iter()
            .flat_map(|m| m.keys())
            .chain(allowed.into_iter().flat_map(|m| m.keys()))
            .map(String::as_str)
            .collect();
        for file in files {
            let n = have.and_then(|m| m.get(file)).copied().unwrap_or(0);
            let b = allowed.and_then(|m| m.get(file)).copied().unwrap_or(0);
            if n > b {
                over.push(BudgetDelta {
                    rule: rule.to_owned(),
                    file: file.to_owned(),
                    count: n,
                    budget: b,
                });
            } else if n < b {
                under.push(BudgetDelta {
                    rule: rule.to_owned(),
                    file: file.to_owned(),
                    count: n,
                    budget: b,
                });
            }
        }
    }
    (over, under)
}

pub fn totals(map: &BudgetMap) -> BTreeMap<String, usize> {
    map.iter()
        .map(|(rule, files)| (rule.clone(), files.values().sum()))
        .collect()
}

pub fn lint_copy(root: &Path, budget: &BudgetMap) -> Result<CopyCheck> {
    let m = measure(root)?;
    let (over, under) = compare_budget(&m.measured, budget);
    Ok(CopyCheck {
        missing: m.missing,
        measured: m.measured,
        findings: m.findings,
        over,
        under,
        scanned: m.scanned,
    })
}

pub fn rule_report(root: &Path) -> RuleReport {
    const NAME: &str = "copy-budget";
    let budget = match load_budget(root) {
        Ok(b) => b,
        Err(err) => {
            return RuleReport::applied(NAME, 0, vec![format!("{BUDGET_PATH}: {err:#}")]);
        }
    };
    let check = match lint_copy(root, &budget) {
        Ok(c) => c,
        Err(err) => {
            return RuleReport::applied(NAME, 0, vec![format!("copy-budget: {err:#}")]);
        }
    };
    let mut findings = Vec::new();
    for m in &check.missing {
        findings.push(format!("target does not exist: {m}"));
    }
    for o in &check.over {
        findings.push(format!(
            "{} {}: {} (budget {}) — cut the words; run `cargo xtask rules copy --list`",
            o.rule, o.file, o.count, o.budget
        ));
    }
    for u in &check.under {
        findings.push(format!(
            "{} {}: {} (budget {}) — ratchet down in {BUDGET_PATH} to {}",
            u.rule, u.file, u.count, u.budget, u.count
        ));
    }
    RuleReport::applied(NAME, check.scanned, findings)
}

pub fn run_cli(root: &Path, print: bool, list: bool) -> Result<bool> {
    if print {
        let m = measure(root)?;
        if !m.missing.is_empty() {
            eprintln!("FAIL — target does not exist: {}", m.missing.join(", "));
            return Ok(false);
        }
        print!("{}", format_budget_toml(&m.measured));
        return Ok(true);
    }
    let budget = load_budget(root)?;
    let check = lint_copy(root, &budget)?;
    if !check.missing.is_empty() {
        eprintln!("FAIL — target does not exist: {}", check.missing.join(", "));
        return Ok(false);
    }
    if list {
        for f in &check.findings {
            println!("{}  {}  {}: {}", f.rule, f.file, f.key, f.detail);
        }
        return Ok(true);
    }
    if !check.over.is_empty() {
        eprintln!("\nFAIL — copy exceeds its budget:\n");
        for o in &check.over {
            eprintln!(
                "  {}  {}: {} (budget {})",
                o.rule, o.file, o.count, o.budget
            );
        }
        eprintln!(
            "\ndesign/wording.md § Wording: cut the words, use the vocabulary table, keep reassurance\n\
             to consent, destructive confirms and security disclosures. Do not raise the\n\
             budget. Run `cargo xtask rules copy --list` to name the offending keys.\n"
        );
    }
    if !check.under.is_empty() {
        eprintln!("\nFAIL — ratchet down: the measured count is below budget:\n");
        for u in &check.under {
            let extra = if u.count == 0 { " (delete it)" } else { "" };
            eprintln!(
                "  {}  {}: {} (budget {}) — lower the entry to {}{extra} in {BUDGET_PATH}",
                u.rule, u.file, u.count, u.budget, u.count
            );
        }
        eprintln!(
            "\nThe budget only shrinks, and it shrinks in the same change that fixes the debt.\n"
        );
    }
    if !check.over.is_empty() || !check.under.is_empty() {
        return Ok(false);
    }
    let t = totals(&check.measured);
    let summary = if t.is_empty() {
        "no debt".to_owned()
    } else {
        t.iter()
            .map(|(r, n)| format!("{r}={n}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    println!("ok   copy at budget: {summary}");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule_names(key: &str, value: &str) -> Vec<&'static str> {
        lint_string(key, value)
            .into_iter()
            .map(|(r, _)| r)
            .collect()
    }

    #[test]
    fn word_count_skips_dashes_and_dots_and_counts_placeholder_as_one() {
        assert_eq!(word_count("Edited · {when}"), 2);
        assert_eq!(word_count("One — two  three"), 3);
        assert_eq!(word_count(""), 0);
    }

    #[test]
    fn plain_banned_words_are_caught_case_insensitively() {
        for v in [
            "Please wait",
            "Saved successfully",
            "Simply tap it",
            "Tap in order to save",
            "You can tap it",
            "We're sorry about that",
            "We’re sorry about that",
        ] {
            assert_eq!(rule_names("X_NOTE", v), vec!["copy-banned-word"], "{v}");
        }
        assert!(rule_names("X_NOTE", "You can't undo this").is_empty());
        assert!(rule_names("X_NOTE", "Simplyfied").is_empty());
    }

    #[test]
    fn internals_jargon_is_banned_and_ordinary_neighbours_are_not() {
        for v in [
            "Secrets stay sealed",
            "Unseal the vault",
            "A receipt was written",
            "The ledger is empty",
            "Draining the queue",
            "A derived index",
            "Kept in memory",
            "Encrypted at rest",
            "Private by design",
            "Call core.open first",
            "A photograph of you",
            "Stays on this device",
        ] {
            assert_eq!(rule_names("X_NOTE", v), vec!["copy-banned-word"], "{v}");
        }
        for v in [
            "Photo deleted",
            "Changed on another device",
            "The core idea",
            "Sealant",
        ] {
            assert!(rule_names("X_NOTE", v).is_empty(), "{v}");
        }
    }

    #[test]
    fn gateway_allowed_only_inside_quoted_centraid_gateway_command() {
        assert_eq!(banned_in("K", "The gateway is gone"), vec!["gateway"]);
        assert_eq!(banned_in("K", "Run centraid-gateway pair"), vec!["gateway"]);
        assert!(banned_in("K", "Run “centraid-gateway pair”").is_empty());
        assert!(banned_in("K", "Run `centraid-gateway pairings revoke`").is_empty());
        assert_eq!(
            banned_in("K", "Run \"centraid-gateway pair\" on the gateway"),
            vec!["gateway"]
        );
    }

    #[test]
    fn twenty_four_words_allowed_only_where_member_types_recovery_key() {
        assert_eq!(
            banned_in("SAVE_BODY", "Write down your 24 words"),
            vec!["24 words"]
        );
        assert!(banned_in("TYPE_BODY", "Type your 24 words").is_empty());
        assert!(banned_in("ENTER_NOTE", "Enter all 24 words").is_empty());
        assert!(banned_in("PAIR_WORDS_NOTE", "The 24 words").is_empty());
        assert!(banned_in("COUNT_ONE", "There are 24 words").is_empty());
        assert!(banned_in("REKEY_BODY", "Type the 24 words of your recovery key").is_empty());
    }

    #[test]
    fn dot_join_exempt_as_short_metadata_and_flagged_as_two_thoughts() {
        assert!(rule_names("X_META", "Edited · 3 days ago").is_empty());
        assert!(rule_names("X_META", "Edited · {when} · {who}").is_empty());
        assert_eq!(
            rule_names(
                "X_META",
                "Titles are browsable · a secret is only opened when you unlock"
            ),
            vec!["copy-dot-join"]
        );
        assert!(
            rule_names(
                "X_META",
                "Titles are browsable. A secret opens when you unlock"
            )
            .is_empty()
        );
    }

    #[test]
    fn caps_follow_key_suffix_and_first_matching_class_wins() {
        assert_eq!(cap_for("LOCK_NO_WORDS_ACTION").map(|c| c.max), Some(4));
        assert_eq!(cap_for("SAVE"), None);
        assert_eq!(cap_for("ROW_DETAIL").map(|c| c.max), Some(12));
        assert_eq!(cap_for("X_BODY").map(|c| c.max), Some(25));
        assert_eq!(cap_for("X_FAILED").map(|c| c.max), Some(25));
        assert_eq!(cap_for("X_TITLE").map(|c| c.max), Some(6));
        assert_eq!(cap_for("TITLE").map(|c| c.max), Some(6));
        assert_eq!(cap_for("X_TITLES"), None);
        assert_eq!(cap_for("RETITLE"), None);

        let words = |n: usize| {
            (0..n)
                .map(|i| format!("w{i}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert!(rule_names("A_ACTION", &words(4)).is_empty());
        assert_eq!(rule_names("A_ACTION", &words(5)), vec!["copy-over-budget"]);
        assert!(rule_names("A_NOTE", &words(12)).is_empty());
        assert_eq!(rule_names("A_NOTE", &words(13)), vec!["copy-over-budget"]);
        assert!(rule_names("A_BODY", &words(25)).is_empty());
        assert_eq!(rule_names("A_BODY", &words(26)), vec!["copy-over-budget"]);
        assert_eq!(rule_names("A_TITLE", &words(7)), vec!["copy-over-budget"]);
        assert!(rule_names("A_OTHER", &words(40)).is_empty());
        assert!(rule_names("A_BODY", "Save {name} to {place} now").is_empty());
    }

    #[test]
    fn string_counts_once_per_rule_however_often_it_offends() {
        let doc: serde_json::Value = serde_json::json!({
            "A_NOTE": "Please simply wait",
            "B_NOTE": "Fine",
            "C_NOTE": 3
        });
        let found = scan_strings_json("copy/a.json", doc.as_object().expect("obj"));
        let pairs: Vec<(&str, &str)> = found.iter().map(|f| (f.key.as_str(), f.rule)).collect();
        assert_eq!(pairs, vec![("A_NOTE", "copy-banned-word")]);
    }

    #[test]
    fn compare_budget_flags_growth_new_files_and_unlowered_budgets() {
        let mut measured = BudgetMap::new();
        measured.insert(
            "r".into(),
            [
                ("a.json".into(), 3),
                ("b.json".into(), 1),
                ("new.json".into(), 1),
            ]
            .into(),
        );
        let mut budget = BudgetMap::new();
        budget.insert(
            "r".into(),
            [
                ("a.json".into(), 2),
                ("b.json".into(), 2),
                ("gone.json".into(), 1),
            ]
            .into(),
        );
        let (over, under) = compare_budget(&measured, &budget);
        assert_eq!(
            over.iter().map(|o| o.file.as_str()).collect::<Vec<_>>(),
            vec!["a.json", "new.json"]
        );
        assert_eq!(
            under.iter().map(|u| u.file.as_str()).collect::<Vec<_>>(),
            vec!["b.json", "gone.json"]
        );
    }

    #[test]
    fn totals_sums_each_rule() {
        let mut map = BudgetMap::new();
        map.insert("r".into(), [("a".into(), 2), ("b".into(), 3)].into());
        map.insert("s".into(), [("a".into(), 1)].into());
        let t = totals(&map);
        assert_eq!(t.get("r"), Some(&5));
        assert_eq!(t.get("s"), Some(&1));
    }

    #[test]
    fn lint_copy_reads_strings_only_and_honours_budget() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        fs::create_dir_all(root.join("copy")).expect("mkdir copy");
        fs::create_dir_all(root.join(CATALOG_DIR)).expect("mkdir catalog");
        fs::write(
            root.join("copy/a.json"),
            serde_json::json!({
                "$comment": "Please ignore this successfully",
                "app": "a",
                "strings": { "X_NOTE": "Please wait", "X_TITLE": "Fine" },
                "routes": { "R": "Please, simply, in order to" }
            })
            .to_string(),
        )
        .expect("write");
        fs::write(root.join("copy/notes.txt"), "not json").expect("write");

        let mut ok_budget = BudgetMap::new();
        ok_budget.insert(
            "copy-banned-word".into(),
            [("copy/a.json".into(), 1)].into(),
        );
        let ok = lint_copy(root, &ok_budget).expect("lint");
        assert!(ok.over.is_empty());
        assert!(ok.under.is_empty());
        assert!(ok.missing.is_empty());

        let grew = lint_copy(root, &BudgetMap::new()).expect("lint");
        assert_eq!(grew.over.len(), 1);

        let mut stale_budget = BudgetMap::new();
        stale_budget.insert(
            "copy-banned-word".into(),
            [("copy/a.json".into(), 2)].into(),
        );
        let stale = lint_copy(root, &stale_budget).expect("lint");
        assert_eq!(stale.under.len(), 1);

        let missing = lint_copy(&root.join("nowhere"), &BudgetMap::new()).expect("lint");
        assert_eq!(missing.missing, vec![CATALOG_DIR, COPY_DIR]);
    }

    #[test]
    fn catalog_row_reads_across_lines_inside_catalog_only_once_per_key() {
        let source = [
            r#"//! plain doc_quote = ("Please ignore", "Please ignore");"#,
            "catalog! {",
            r#"    plain x_note = ("Please wait", "Please wait");"#,
            "    // a comment row",
            "    counted y_title = (",
            r#"        "{n} \"thing\"","#,
            r#"        "{n} things""#,
            "    );",
            "}",
        ]
        .join("\n");
        let parsed = catalog_strings(&source);
        assert_eq!(
            parsed.get("X_NOTE"),
            Some(&["Please wait".to_owned(), "Please wait".to_owned()])
        );
        assert_eq!(
            parsed.get("Y_TITLE"),
            Some(&["{n} \"thing\"".to_owned(), "{n} things".to_owned()])
        );
        assert!(!parsed.contains_key("DOC_QUOTE"));

        let twice =
            "catalog! {\n    counted z_note = (\"Please wait\", \"Simply please wait\");\n}";
        let found = scan_catalog("a.rs", twice);
        let pairs: Vec<(&str, &str)> = found.iter().map(|f| (f.key.as_str(), f.rule)).collect();
        assert_eq!(pairs, vec![("Z_NOTE", "copy-banned-word")]);
    }

    #[test]
    fn lint_copy_reads_rust_catalogue_as_well_as_copy_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        fs::create_dir_all(root.join("copy")).expect("mkdir");
        fs::create_dir_all(root.join(CATALOG_DIR)).expect("mkdir");
        fs::write(
            root.join("crates/screens/src/strings/a.rs"),
            "catalog! {\n    plain x_note = (\"Please wait\", \"Please wait\");\n}\n",
        )
        .expect("write");
        let found = lint_copy(root, &BudgetMap::new()).expect("lint");
        assert_eq!(
            found
                .over
                .iter()
                .map(|o| o.file.as_str())
                .collect::<Vec<_>>(),
            vec!["crates/screens/src/strings/a.rs"]
        );
    }
}
