//! RULES: a description to a category (R-1099-4, seam S2).
//!
//! The vault's `rule.apply` (`centraid_vault::commands::rule`) and this module MUST agree on every
//! case; wave 3's test proves it against the real vault. A rule matches by
//! **what the description says** — `is`, `contains` or `matches` (a wildcard:
//! `*` any run, `?` one character, everything else literal; no regex crate) —
//! and optionally by an amount range on the **magnitude** and by account.
//!
//! All matching rules apply. They are ordered by `(specificity, position,
//! rule_id)` ascending and **the last rule to set the category wins** — so the most specific rule decides, and a tie goes to the later
//! position. Specificity is the kind's weight (three for `is`, two for `matches`,
//! one for `contains`) plus one for each of the lower amount bound, the upper
//! amount bound and the account that is set.
//!
//! The **counting learner** ([`propose_rule`]) is the only inference: when the
//! member categorises a row and three of that merchant's last five categorised
//! rows share the category, and no rule already yields it, it PROPOSES a
//! `contains <merchant>` rule. It never creates one.

use serde::{Deserialize, Serialize};

use crate::import::ImportRow;

/// The most rules a vault holds (R-1099-7's sibling ceiling).
pub const RULES: usize = 500;

/// The merchant's recent categorised rows the learner counts.
pub const LEARNER_WINDOW: usize = 5;
/// Rows in the window that must agree.
pub const LEARNER_SUPPORT: usize = 3;

/// How a rule's pattern is compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    Is,
    Contains,
    Matches,
}

impl MatchKind {
    const fn weight(self) -> u32 {
        match self {
            Self::Is => 3,
            Self::Matches => 2,
            Self::Contains => 1,
        }
    }

    /// The vault column's spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Is => "is",
            Self::Contains => "contains",
            Self::Matches => "matches",
        }
    }
}

/// One rule, as the vault stores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub rule_id: String,
    pub kind: MatchKind,
    pub pattern: String,
    /// Inclusive lower bound on the magnitude; `None` is unbounded.
    pub amount_min_minor: Option<i64>,
    pub amount_max_minor: Option<i64>,
    /// `None` is any account.
    pub account_id: Option<String>,
    pub category_concept_id: Option<String>,
    pub position: i64,
}

/// What a rule is asked about.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub description: &'a str,
    /// The magnitude, > 0.
    pub amount_minor: i64,
    pub account_id: &'a str,
}

/// Trim, collapse whitespace runs to one space, ASCII-uppercase; non-ASCII is
/// left as written.
#[must_use]
pub fn normalise(text: &str) -> String {
    text.split_whitespace()
        .map(str::to_ascii_uppercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whole-string wildcard match: `*` any run (empty too), `?` one character.
fn wildcard(pattern: &[char], text: &[char]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

/// Whether `rule` matches `candidate`.
#[must_use]
pub fn matches(rule: &Rule, candidate: &Candidate<'_>) -> bool {
    if rule
        .account_id
        .as_deref()
        .is_some_and(|id| id != candidate.account_id)
    {
        return false;
    }
    if rule
        .amount_min_minor
        .is_some_and(|min| candidate.amount_minor < min)
        || rule
            .amount_max_minor
            .is_some_and(|max| candidate.amount_minor > max)
    {
        return false;
    }
    let description = normalise(candidate.description);
    let pattern = normalise(&rule.pattern);
    match rule.kind {
        MatchKind::Is => description == pattern,
        MatchKind::Contains => description.contains(&pattern),
        MatchKind::Matches => {
            let pattern: Vec<char> = pattern.chars().collect();
            let description: Vec<char> = description.chars().collect();
            wildcard(&pattern, &description)
        }
    }
}

/// The kind's weight plus one for each of the two amount bounds and the account
/// that is set.
#[must_use]
pub fn specificity(rule: &Rule) -> u32 {
    rule.kind.weight()
        + u32::from(rule.amount_min_minor.is_some())
        + u32::from(rule.amount_max_minor.is_some())
        + u32::from(rule.account_id.is_some())
}

/// What the rules say about one row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub category_concept_id: Option<String>,
    /// The matching rules in application order (least specific first).
    pub rule_ids: Vec<String>,
}

/// Applies every matching rule; the last to set a field wins it.
#[must_use]
pub fn apply(rules: &[Rule], candidate: &Candidate<'_>) -> Applied {
    let mut hits: Vec<&Rule> = rules
        .iter()
        .filter(|rule| matches(rule, candidate))
        .collect();
    hits.sort_by(|a, b| {
        (specificity(a), a.position, &a.rule_id).cmp(&(specificity(b), b.position, &b.rule_id))
    });
    let mut applied = Applied::default();
    for rule in hits {
        if let Some(category) = &rule.category_concept_id {
            applied.category_concept_id = Some(category.clone());
        }
        applied.rule_ids.push(rule.rule_id.clone());
    }
    applied
}

/// Sets `row`'s category from the rules.
pub fn apply_to_row(rules: &[Rule], account_id: &str, row: &mut ImportRow) {
    let applied = apply(
        rules,
        &Candidate {
            description: &row.description,
            amount_minor: row.amount_minor,
            account_id,
        },
    );
    row.category_concept_id = applied.category_concept_id;
}

// ---------------------------------------------------------------------------
// The counting learner.
// ---------------------------------------------------------------------------

fn digits_at(chars: &[char], at: usize) -> usize {
    chars[at..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count()
}

/// A merchant's key: the normalised description with the store and reference
/// numbers a bank appends stripped (`SQ *`, ` #1234…`, a phone number,
/// `*AB12C`, ` PPD ID:…`, a trailing run of four or more digits).
#[must_use]
pub fn merchant_key(description: &str) -> String {
    let mut key = normalise(description);
    if let Some(rest) = key.strip_prefix("SQ *") {
        key = rest.trim_start().to_owned();
    }
    let cut_at = |key: &str, found: Option<usize>| -> String {
        found.map_or_else(|| key.to_owned(), |at| key[..at].trim_end().to_owned())
    };
    // " #<digits>…"
    let chars: Vec<char> = key.chars().collect();
    let store = (1..chars.len().saturating_sub(1))
        .find(|&at| chars[at] == '#' && chars[at - 1] == ' ' && chars[at + 1].is_ascii_digit())
        .map(|at| chars[..at].iter().map(|c| c.len_utf8()).sum::<usize>());
    key = cut_at(&key, store);
    // " ddd-ddd-dddd…"
    let chars: Vec<char> = key.chars().collect();
    let phone = (1..chars.len()).find(|&at| {
        chars[at - 1] == ' '
            && digits_at(&chars, at) == 3
            && chars.get(at + 3) == Some(&'-')
            && digits_at(&chars, at + 4) == 3
            && chars.get(at + 7) == Some(&'-')
            && digits_at(&chars, at + 8) >= 4
    });
    let phone = phone.map(|at| chars[..at].iter().map(|c| c.len_utf8()).sum::<usize>());
    key = cut_at(&key, phone);
    // "*<alnum>" at the very end
    if let Some(star) = key.rfind('*') {
        let tail = &key[star + 1..];
        if !tail.is_empty()
            && tail
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        {
            key = key[..star].trim_end().to_owned();
        }
    }
    // " PPD ID:…"
    key = cut_at(&key, key.find(" PPD ID:"));
    // trailing " dddd+"
    if let Some(space) = key.rfind(' ') {
        let tail = &key[space + 1..];
        if tail.len() >= 4 && tail.chars().all(|c| c.is_ascii_digit()) {
            key = key[..space].trim_end().to_owned();
        }
    }
    key.trim().to_owned()
}

/// One categorised row, as the learner counts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Categorised {
    pub txn_id: String,
    pub description: String,
    /// `YYYY-MM-DD`.
    pub posted_on: String,
    /// `None` while the row has no category.
    pub category_concept_id: Option<String>,
}

/// A rule the learner suggests; written by nobody until the member accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleProposal {
    pub kind: MatchKind,
    pub pattern: String,
    pub category_concept_id: String,
    /// How many of the last `of` rows share the category.
    pub support: usize,
    pub of: usize,
}

/// The rule to propose after the member categorised `just`, given every
/// categorised row of the account (`just` included).
#[must_use]
pub fn propose_rule(
    rules: &[Rule],
    account_id: &str,
    history: &[Categorised],
    just: &Categorised,
    just_amount_minor: i64,
) -> Option<RuleProposal> {
    let category = just.category_concept_id.as_deref()?;
    let applied = apply(
        rules,
        &Candidate {
            description: &just.description,
            amount_minor: just_amount_minor,
            account_id,
        },
    );
    // "no rule already yields it": a rule that already lands this category.
    if applied.category_concept_id.as_deref() == Some(category) {
        return None;
    }
    let key = merchant_key(&just.description);
    if key.is_empty() {
        return None;
    }
    let mut same: Vec<&Categorised> = history
        .iter()
        .filter(|row| row.category_concept_id.is_some() && merchant_key(&row.description) == key)
        .collect();
    same.sort_by(|a, b| (&b.posted_on, &b.txn_id).cmp(&(&a.posted_on, &a.txn_id)));
    same.truncate(LEARNER_WINDOW);
    let support = same
        .iter()
        .filter(|row| row.category_concept_id.as_deref() == Some(category))
        .count();
    if support < LEARNER_SUPPORT {
        return None;
    }
    Some(RuleProposal {
        kind: MatchKind::Contains,
        pattern: key,
        category_concept_id: category.to_owned(),
        support,
        of: same.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, kind: MatchKind, pattern: &str) -> Rule {
        Rule {
            rule_id: id.to_owned(),
            kind,
            pattern: pattern.to_owned(),
            amount_min_minor: None,
            amount_max_minor: None,
            account_id: None,
            category_concept_id: Some(format!("cat-{id}")),
            position: 0,
        }
    }

    fn candidate<'a>(description: &'a str, amount: i64) -> Candidate<'a> {
        Candidate {
            description,
            amount_minor: amount,
            account_id: "acct-1",
        }
    }

    #[test]
    fn normalise_collapses_whitespace_and_uppercases_ascii_only() {
        assert_eq!(normalise("  Café   au\tlait "), "CAFé AU LAIT");
    }

    #[test]
    fn the_three_kinds() {
        let is = rule("a", MatchKind::Is, "starbucks  #1");
        assert!(matches(&is, &candidate("STARBUCKS #1", 500)));
        assert!(!matches(&is, &candidate("STARBUCKS #12", 500)));
        let contains = rule("b", MatchKind::Contains, "shell");
        assert!(matches(&contains, &candidate("POS SHELL OIL 123", 500)));
        let wild = rule("c", MatchKind::Matches, "amzn*mktp ??");
        assert!(matches(&wild, &candidate("AMZN Mktp US", 500)));
        assert!(matches(&wild, &candidate("AMZN-X-MKTP CA", 500)));
        assert!(!matches(&wild, &candidate("AMZN Mktp USA", 500)));
        assert!(matches(
            &rule("d", MatchKind::Matches, "*"),
            &candidate("", 1)
        ));
    }

    #[test]
    fn amount_bounds_are_inclusive_on_the_magnitude_and_account_is_equality() {
        let mut bounded = rule("a", MatchKind::Contains, "gym");
        bounded.amount_min_minor = Some(1000);
        bounded.amount_max_minor = Some(2000);
        assert!(matches(&bounded, &candidate("GYM", 1000)));
        assert!(matches(&bounded, &candidate("GYM", 2000)));
        assert!(!matches(&bounded, &candidate("GYM", 999)));
        assert!(!matches(&bounded, &candidate("GYM", 2001)));
        bounded.account_id = Some("other".to_owned());
        assert!(!matches(&bounded, &candidate("GYM", 1500)));
    }

    #[test]
    fn the_most_specific_rule_wins_the_category_and_a_tie_goes_to_the_later_position() {
        let broad = rule("broad", MatchKind::Contains, "amazon");
        let mut exact = rule("exact", MatchKind::Is, "amazon prime");
        exact.category_concept_id = Some("subscriptions".to_owned());
        let applied = apply(
            &[exact.clone(), broad.clone()],
            &candidate("AMAZON PRIME", 1599),
        );
        assert_eq!(
            applied.category_concept_id.as_deref(),
            Some("subscriptions")
        );
        assert_eq!(applied.rule_ids, vec!["broad", "exact"]);
        let mut early = rule("a", MatchKind::Contains, "x");
        early.position = 1;
        let mut late = rule("b", MatchKind::Contains, "x");
        late.position = 2;
        let applied = apply(&[late, early], &candidate("X", 1));
        assert_eq!(applied.category_concept_id.as_deref(), Some("cat-b"));
        assert_eq!(specificity(&exact), 3);
    }

    #[test]
    fn merchant_keys_drop_store_and_reference_numbers() {
        assert_eq!(merchant_key("SQ *BLUE BOTTLE #42 SF"), "BLUE BOTTLE");
        assert_eq!(merchant_key("Starbucks #1234 Seattle"), "STARBUCKS");
        assert_eq!(merchant_key("COSTCO 800-555-1234 WA"), "COSTCO");
        assert_eq!(merchant_key("AMZN MKTP US*2K4XY"), "AMZN MKTP US");
        assert_eq!(merchant_key("PAYROLL PPD ID: 123456"), "PAYROLL");
        assert_eq!(merchant_key("SHELL OIL 57444212"), "SHELL OIL");
        assert_eq!(merchant_key("NETFLIX"), "NETFLIX");
    }

    fn row(id: &str, day: &str, category: Option<&str>) -> Categorised {
        Categorised {
            txn_id: id.to_owned(),
            description: "Starbucks #12".to_owned(),
            posted_on: day.to_owned(),
            category_concept_id: category.map(str::to_owned),
        }
    }

    #[test]
    fn three_of_the_last_five_propose_a_contains_rule_and_two_do_not() {
        let history = vec![
            row("1", "2024-01-01", Some("coffee")),
            row("2", "2024-01-02", Some("coffee")),
            row("3", "2024-01-03", Some("eating-out")),
            row("4", "2024-01-04", Some("coffee")),
        ];
        let just = history[3].clone();
        let proposal = propose_rule(&[], "acct-1", &history, &just, 500).expect("3 of 4 agree");
        assert_eq!(
            (
                proposal.kind,
                proposal.pattern.as_str(),
                proposal.support,
                proposal.of
            ),
            (MatchKind::Contains, "STARBUCKS", 3, 4)
        );
        assert!(propose_rule(&[], "acct-1", &history[..3], &history[1], 500).is_none());
        // A rule that already yields the category silences it.
        let existing = rule("r", MatchKind::Contains, "starbucks");
        let mut existing = existing;
        existing.category_concept_id = Some("coffee".to_owned());
        assert!(propose_rule(&[existing], "acct-1", &history, &just, 500).is_none());
    }
}
