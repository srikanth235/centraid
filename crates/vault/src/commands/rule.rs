//! `rule.*`: "a line matching this goes in that category" (#1099, seam S2).
//!
//! A rule matches by **what the line's words say** (the statement's own text,
//! kept in `source.stated`, so renaming a line never changes what matches it) —
//! `is`, `contains` or `matches` (a wildcard: `*` any run, `?` one character,
//! everything else literal; no regex) — and optionally by an amount range on the
//! **magnitude** and by account. The pattern is one JSON value on the row:
//! `{"match", "text", "min", "max", "account"}`, the keys a rule does not use
//! left out.
//!
//! All matching rules apply, ordered by `(specificity, position, id)` ascending;
//! the last one to set the category wins, so the most specific rule decides and
//! a tie goes to the later position. Specificity is the kind's weight (three for
//! `is`, two for `matches`, one for `contains`) plus one for each of the lower
//! bound, the upper bound and the account that is set.
//!
//! `apply` and `centraid_apps_money::rules` implement ONE spec, independently,
//! and a test in the app crate runs both against the same fixture.

use serde_json::{Value as Json, json};

use crate::commands::money::{fileable, is_live};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::Result;
use crate::model::Kind;

/// The words a pattern's `match` takes.
pub const MATCH_KINDS: [&str; 3] = ["is", "contains", "matches"];

/// A description as a rule sees it: trimmed, runs of whitespace collapsed to one
/// space, ASCII upper-cased (anything else is left as written). Whitespace is
/// Rust's `char::is_whitespace` (Unicode `White_Space`).
#[must_use]
pub fn normalise(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

/// `*` is any run (including none), `?` is exactly one character, everything
/// else is literal; the whole string must match.
#[must_use]
pub fn wildcard_matches(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) && pattern[p] != '*' {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

/// One rule, loaded.
#[derive(Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub kind: String,
    /// Already [`normalise`]d.
    pub text: String,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub account: Option<String>,
    pub category: String,
    pub position: f64,
}

impl Rule {
    /// `is` weighs 3, `matches` 2, `contains` 1, plus 1 for each of the lower
    /// bound, the upper bound and the account that is set.
    #[must_use]
    pub fn specificity(&self) -> i64 {
        let kind = match self.kind.as_str() {
            "is" => 3,
            "matches" => 2,
            _ => 1,
        };
        kind + i64::from(self.min.is_some())
            + i64::from(self.max.is_some())
            + i64::from(self.account.is_some())
    }

    /// Does this rule match a line? `normalised` is the line's description after
    /// [`normalise`]; `magnitude` is its amount without the sign.
    #[must_use]
    pub fn matches(&self, normalised: &str, magnitude: i64, account_id: &str) -> bool {
        let text_ok = match self.kind.as_str() {
            "is" => normalised == self.text,
            "contains" => normalised.contains(&self.text),
            _ => wildcard_matches(&self.text, normalised),
        };
        text_ok
            && self.min.is_none_or(|min| magnitude >= min)
            && self.max.is_none_or(|max| magnitude <= max)
            && self.account.as_deref().is_none_or(|id| id == account_id)
    }
}

/// What a rule is made of, before it is stored: the words a member typed.
struct Draft {
    kind: String,
    text: String,
    min: Option<i64>,
    max: Option<i64>,
    account: Option<String>,
    category: String,
}

impl Draft {
    fn pattern(&self) -> String {
        let mut pattern = serde_json::Map::new();
        pattern.insert("match".to_owned(), json!(self.kind));
        pattern.insert("text".to_owned(), json!(self.text));
        pattern.insert("min".to_owned(), json!(self.min));
        pattern.insert("max".to_owned(), json!(self.max));
        pattern.insert("account".to_owned(), json!(self.account));
        pattern.retain(|_, value| !value.is_null());
        Json::Object(pattern).to_string()
    }
}

fn parse(id: &str, pattern: &str, category: String, position: f64) -> Rule {
    let pattern: Json = serde_json::from_str(pattern).unwrap_or(Json::Null);
    let text = |key: &str| pattern.get(key).and_then(Json::as_str).map(str::to_owned);
    Rule {
        id: id.to_owned(),
        kind: text("match").unwrap_or_default(),
        text: normalise(&text("text").unwrap_or_default()),
        min: pattern.get("min").and_then(Json::as_i64),
        max: pattern.get("max").and_then(Json::as_i64),
        account: text("account"),
        category,
        position,
    }
}

/// Every rule, in the order they apply.
pub fn load(connection: &rusqlite::Connection) -> Result<Vec<Rule>> {
    let mut rules: Vec<Rule> = connection
        .prepare("SELECT id, pattern, category_id, position FROM rule")?
        .query_map([], |row| {
            Ok(parse(
                &row.get::<_, String>(0)?,
                &row.get::<_, String>(1)?,
                row.get(2)?,
                row.get(3)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    rules.sort_by(|a, b| {
        a.specificity()
            .cmp(&b.specificity())
            .then(a.position.total_cmp(&b.position))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(rules)
}

/// The draft a command states, over the stored one when it edits.
fn draft(ctx: &CommandCtx<'_, '_>, base: Option<&Rule>, stored: Option<&Json>) -> Draft {
    let stated = |key: &str| ctx.input.get(key);
    let text = |key: &str, held: Option<String>| match stated(key) {
        None => held,
        Some(value) => value.as_str().map(|text| text.trim().to_owned()),
    };
    let int = |key: &str, held: Option<i64>| match stated(key) {
        None => held,
        Some(value) => value.as_i64(),
    };
    let held_text = stored
        .and_then(|pattern| pattern.get("text"))
        .and_then(Json::as_str)
        .map(str::to_owned);
    Draft {
        kind: text("match", base.map(|rule| rule.kind.clone())).unwrap_or_default(),
        text: text("text", held_text).unwrap_or_default(),
        min: int("min", base.and_then(|rule| rule.min)),
        max: int("max", base.and_then(|rule| rule.max)),
        account: text("account_id", base.and_then(|rule| rule.account.clone())),
        category: text("category_id", base.map(|rule| rule.category.clone())).unwrap_or_default(),
    }
}

fn judge(ctx: &CommandCtx<'_, '_>, draft: &Draft, moved: bool) -> Result<Option<String>> {
    let connection = ctx.connection();
    if draft.text.is_empty() {
        return Ok(Some("A rule needs something to look for.".to_owned()));
    }
    if let (Some(min), Some(max)) = (draft.min, draft.max)
        && min > max
    {
        return Ok(Some(
            "The smallest amount is more than the largest.".to_owned(),
        ));
    }
    if draft.min.is_some_and(|min| min < 0) || draft.max.is_some_and(|max| max < 0) {
        return Ok(Some("An amount range is never negative.".to_owned()));
    }
    if let Some(account) = &draft.account
        && !is_live(connection, account, Kind::Account)?
    {
        return Ok(Some("There is no Money account with that id.".to_owned()));
    }
    // A rule that already files under an archived category may be edited in
    // another way; only a new choice of category must be a live one.
    if moved {
        return fileable(connection, &draft.category);
    }
    Ok(None)
}

fn stored(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Option<(Rule, Json)>> {
    use rusqlite::OptionalExtension;
    let row: Option<(String, String, f64)> = ctx
        .connection()
        .query_row(
            "SELECT pattern, category_id, position FROM rule WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(row.map(|(pattern, category, position)| {
        let json = serde_json::from_str(&pattern).unwrap_or(Json::Null);
        (parse(id, &pattern, category, position), json)
    }))
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(id) = ctx.optional_str("id")
        && stored(ctx, id)?.is_some()
    {
        return Ok(Some("A rule with that id already exists.".to_owned()));
    }
    judge(ctx, &draft(ctx, None, None), true)
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let draft = draft(ctx, None, None);
    let id = ctx
        .optional_str("id")
        .map_or_else(|| ctx.next_id(), str::to_owned);
    let position: f64 = match ctx.input.get("position").and_then(Json::as_f64) {
        Some(position) => position,
        None => ctx.connection().query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM rule",
            [],
            |row| row.get(0),
        )?,
    };
    ctx.connection().execute(
        "INSERT INTO rule (id, pattern, category_id, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, draft.pattern(), draft.category, position, ctx.now],
    )?;
    Ok(json!({ "id": id, "position": position }))
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some((rule, pattern)) = stored(ctx, ctx.required_str("id")?)? else {
        return Ok(Some("There is no such rule.".to_owned()));
    };
    let moved = ctx.input.get("category_id").is_some();
    judge(ctx, &draft(ctx, Some(&rule), Some(&pattern)), moved)
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let Some((rule, pattern)) = stored(ctx, id)? else {
        return Ok(json!({ "id": id, "changed": false }));
    };
    let draft = draft(ctx, Some(&rule), Some(&pattern));
    let position = ctx
        .input
        .get("position")
        .and_then(Json::as_f64)
        .unwrap_or(rule.position);
    let changed = ctx.connection().execute(
        "UPDATE rule SET pattern = ?2, category_id = ?3, position = ?4
          WHERE id = ?1 AND (pattern, category_id, position) IS NOT (?2, ?3, ?4)",
        rusqlite::params![id, draft.pattern(), draft.category, position],
    )? > 0;
    Ok(json!({ "id": id, "changed": changed }))
}

fn delete(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    // Deleting what is not there is the same end state as deleting it.
    let deleted = ctx
        .connection()
        .execute("DELETE FROM rule WHERE id = ?1", [ctx.required_str("id")?])?
        > 0;
    Ok(json!({ "deleted": deleted }))
}

fn pre_apply(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(match ctx.optional_str("id") {
        Some(id) if stored(ctx, id)?.is_none() => Some("There is no such rule.".to_owned()),
        _ => None,
    })
}

/// File the member's history by the rules: every line a rule matches that has no
/// category (or, with `overwrite`, any category) takes the category the deciding
/// rule names. With an `id`, only lines that rule matches are touched.
fn apply(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let only = ctx.optional_str("id");
    let overwrite = ctx
        .input
        .get("overwrite")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let rules = load(ctx.connection())?;
    type History = (String, String, i64, Option<String>, String);
    let lines: Vec<History> = ctx
        .connection()
        .prepare(
            "SELECT t.id, t.account_id, abs(t.amount_minor), t.category_id,
                    COALESCE(json_extract(s.stated, '$.title'), e.title)
               FROM txn t JOIN entity e ON e.id = t.id
               LEFT JOIN source s ON s.entity_id = t.id
              WHERE e.deleted_at IS NULL AND t.status <> 'void'
              ORDER BY t.id",
        )?
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let (mut matched, mut recategorised) = (0usize, 0usize);
    for (id, account, magnitude, held, words) in lines {
        let text = normalise(&words);
        let mut decided: Option<&str> = None;
        let mut asked = only.is_none();
        for rule in rules
            .iter()
            .filter(|rule| rule.matches(&text, magnitude, &account))
        {
            asked |= only == Some(rule.id.as_str());
            decided = Some(&rule.category);
        }
        let Some(category) = decided.filter(|_| asked) else {
            continue;
        };
        matched += 1;
        if (overwrite || held.is_none())
            && held.as_deref() != Some(category)
            && ctx.connection().execute(
                "UPDATE txn SET category_id = ?2 WHERE id = ?1",
                [&id, category],
            )? > 0
        {
            ctx.touch(&id)?;
            recategorised += 1;
        }
    }
    Ok(json!({ "matched": matched, "recategorised": recategorised }))
}

/// The properties a rule's commands share, written once.
macro_rules! rule_properties {
    () => {
        r#""match": { "enum": ["is", "contains", "matches"] },
        "text": { "type": "string", "minLength": 1, "maxLength": 200 },
        "min": { "type": ["integer", "null"], "minimum": 0 },
        "max": { "type": ["integer", "null"], "minimum": 0 },
        "account_id": { "type": ["string", "null"], "minLength": 1 },
        "category_id": { "type": "string", "minLength": 1 },
        "position": { "type": "number", "minimum": 0 }"#
    };
}

const ADD_SCHEMA: &str = concat!(
    r#"{ "type": "object", "required": ["match", "text", "category_id"],
        "additionalProperties": false,
        "properties": { "id": { "type": "string", "minLength": 1 }, "#,
    rule_properties!(),
    " } }"
);

const EDIT_SCHEMA: &str = concat!(
    r#"{ "type": "object", "required": ["id"], "additionalProperties": false,
        "properties": { "id": { "type": "string", "minLength": 1 }, "#,
    rule_properties!(),
    " } }"
);

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "rule_is_new_and_sound",
        check: pre_add,
    }];
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "rule_exists_and_is_sound",
        check: pre_edit,
    }];
    const APPLY: &[CommandCondition] = &[CommandCondition {
        predicate: "rule_exists",
        check: pre_apply,
    }];
    let mut apply_rules = CommandDefinition::plain(
        "rule.apply",
        "rule",
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "id": { "type": "string", "minLength": 1 },
            "overwrite": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        APPLY,
        apply,
    );
    apply_rules.risk = Risk::Medium;
    vec![
        CommandDefinition::plain("rule.add", "rule", ADD_SCHEMA, Idempotency::Once, ADD, add),
        CommandDefinition::plain(
            "rule.edit",
            "rule",
            EDIT_SCHEMA,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "rule.delete",
            "rule",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": { "id": { "type": "string", "minLength": 1 } }
            }"#,
            Idempotency::Idempotent,
            &[],
            delete,
        ),
        apply_rules,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: &str, text: &str) -> Rule {
        Rule {
            id: "r".to_owned(),
            kind: kind.to_owned(),
            text: normalise(text),
            min: None,
            max: None,
            account: None,
            category: "category:food".to_owned(),
            position: 0.0,
        }
    }

    #[test]
    fn a_description_is_trimmed_collapsed_and_ascii_uppercased() {
        assert_eq!(
            normalise("  Whole   Foods\u{a0}Mkt é "),
            "WHOLE FOODS MKT é"
        );
    }

    #[test]
    fn a_wildcard_is_whole_string_with_star_and_question_mark() {
        assert!(wildcard_matches("AMZN*", "AMZN MKTP US"));
        assert!(wildcard_matches("A?C", "ABC"));
        assert!(!wildcard_matches("A?C", "AC"));
        assert!(!wildcard_matches("AMZN", "AMZN MKTP"));
        assert!(wildcard_matches("*", ""));
    }

    #[test]
    fn specificity_weighs_the_kind_and_each_bound() {
        let mut bounded = rule("is", "x");
        assert_eq!(bounded.specificity(), 3);
        bounded.min = Some(1);
        bounded.account = Some("a".to_owned());
        assert_eq!(bounded.specificity(), 5);
        assert_eq!(rule("contains", "x").specificity(), 1);
        assert_eq!(rule("matches", "x").specificity(), 2);
    }

    #[test]
    fn a_rule_matches_text_amount_and_account() {
        let mut found = rule("contains", "coffee");
        found.min = Some(100);
        found.max = Some(900);
        found.account = Some("card".to_owned());
        assert!(found.matches("BLUE COFFEE CO", 450, "card"));
        assert!(!found.matches("BLUE COFFEE CO", 50, "card"));
        assert!(!found.matches("BLUE COFFEE CO", 450, "cash"));
        assert!(!found.matches("BLUE TEA CO", 450, "card"));
    }
}
