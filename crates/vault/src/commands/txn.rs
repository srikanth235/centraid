//! A line of an account's ledger: entered by hand or stated by a bank, with its categories in one
//! place ([#1214](https://github.com/srikanth235/centraid/issues/1214), E1 to E4).
//!
//! - **There is no `void`** (E1): a wrong line is trashed like any item, and `entity.trash` is the
//!   verb.
//! - **A line is entered** from a `statement` or by `hand`, on ANY account, and has a `memo` (E2).
//!   Every field of either is the member's to edit; a statement line keeps what its bank last said
//!   in `source.stated`, so a re-import keeps the member's edits and shows the bank's figure beside
//!   them. When a statement arrives the hand lines it seems to match are PROPOSED
//!   ([`proposed_matches`]) and nothing merges until the member confirms (`txn.confirm_match`):
//!   then the statement's amount and day win, the hand line's categories and memo carry over, and
//!   the hand line becomes the statement line (the one change of `entered` the table allows). A
//!   pair the member says is not the same money is dismissed (`txn.dismiss_match`) and kept, so it
//!   is not proposed again.
//! - **A line's categories are `txn_split`** (E3): one part for an ordinary line, several for a
//!   split, none for an uncategorised one, and every report reads that one table. **The parts add
//!   up to the line's amount.** No row-level constraint can say so, so the commit guard says it
//!   once, for every line a commit touched ([`check_split_sums`]), whichever path wrote it.
//! - **A transfer** pairs the two halves of one movement of the member's own money, in one currency
//!   or two (E4). The pair goes with either half, and a line is in at most one.
//! - **The amount is signed: money out is negative.** A line has no currency of its own: it is the
//!   account's, and a foreign purchase keeps what was charged in `original_*`.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::entity::{self, STALE_GUARD, with_rev};
use crate::commands::money::{fileable, is_day, is_free, is_live, unless};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk, arrival,
};
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// The most lines one `txn.categorize` names.
pub const CATEGORIZE_MAX: usize = 2_000;

/// How many days apart a hand line and a statement line may be and still be proposed as one.
pub const MATCH_DAYS: i64 = 3;

// ---------------------------------------------------------------------------
// A line and its parts
// ---------------------------------------------------------------------------

/// A live line, as a command reads it.
struct Line {
    account_id: String,
    amount_minor: i64,
    entered: String,
    parts: i64,
    in_transfer: bool,
    original_amount_minor: Option<i64>,
    original_currency: Option<String>,
}

fn line(connection: &Connection, id: &str) -> Result<Option<Line>> {
    Ok(connection
        .query_row(
            "SELECT t.account_id, t.amount_minor, t.entered,
                    (SELECT COUNT(*) FROM txn_split s WHERE s.txn_id = t.id),
                    EXISTS (SELECT 1 FROM transfer x WHERE x.a = t.id OR x.b = t.id),
                    t.original_amount_minor, t.original_currency
               FROM txn t JOIN entity e ON e.id = t.id
              WHERE t.id = ?1 AND e.deleted_at IS NULL",
            [id],
            |row| {
                Ok(Line {
                    account_id: row.get(0)?,
                    amount_minor: row.get(1)?,
                    entered: row.get(2)?,
                    parts: row.get(3)?,
                    in_transfer: row.get(4)?,
                    original_amount_minor: row.get(5)?,
                    original_currency: row.get(6)?,
                })
            },
        )
        .optional()?)
}

/// One part of a line: a category and the share of the amount filed there.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Part {
    pub category_id: String,
    pub amount_minor: i64,
    pub memo: Option<String>,
}

/// The parts of a line, in order.
///
/// # Errors
/// A database error.
pub fn parts_of(connection: &Connection, id: &str) -> Result<Vec<Part>> {
    Ok(connection
        .prepare_cached(
            "SELECT category_id, amount_minor, memo FROM txn_split WHERE txn_id = ?1 ORDER BY position",
        )?
        .query_map([id], |row| {
            Ok(Part {
                category_id: row.get(0)?,
                amount_minor: row.get(1)?,
                memo: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn write_parts(connection: &Connection, id: &str, parts: &[Part]) -> Result<()> {
    connection.execute("DELETE FROM txn_split WHERE txn_id = ?1", [id])?;
    for (at, part) in parts.iter().enumerate() {
        connection.execute(
            "INSERT INTO txn_split (txn_id, position, category_id, amount_minor, memo)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
                (at + 1) as f64,
                part.category_id,
                part.amount_minor,
                part.memo
            ],
        )?;
    }
    Ok(())
}

/// A sentence when `parts` cannot be a line's categories: a part names a category that is not
/// there to file under, or the parts do not add up to the amount. No parts is an uncategorised line.
fn parts_sentence(connection: &Connection, amount: i64, parts: &[Part]) -> Result<Option<String>> {
    for part in parts {
        if let Some(sentence) = fileable(connection, &part.category_id)? {
            return Ok(Some(sentence));
        }
    }
    let sum: i64 = parts.iter().map(|part| part.amount_minor).sum();
    Ok((!parts.is_empty() && sum != amount)
        .then(|| "The parts of a split add up to the line's amount.".to_owned()))
}

// ---------------------------------------------------------------------------
// The commit guard's rule (E3)
// ---------------------------------------------------------------------------

/// THE ONE PLACE the parts-sum rule is enforced. Called by the commit guard with every entity the
/// commit touched: a line that has parts and whose parts do not add up to its amount fails the
/// commit, whatever wrote it (a command, a follow pass, a restore, a purge, raw SQL). A line with
/// no parts is uncategorised and always holds. One seek of the line by key per touched id.
///
/// # Errors
/// [`VaultError::Invariant`] naming the line, when its parts do not sum.
pub(crate) fn check_split_sums(connection: &Connection, touched: &BTreeSet<String>) -> Result<()> {
    if touched.is_empty() {
        return Ok(());
    }
    let mut statement = connection.prepare_cached(
        "SELECT t.amount_minor, (SELECT SUM(s.amount_minor) FROM txn_split s WHERE s.txn_id = t.id)
           FROM txn t WHERE t.id = ?1",
    )?;
    for id in touched {
        let held: Option<(i64, Option<i64>)> = statement
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        if let Some((amount, Some(sum))) = held
            && amount != sum
        {
            return Err(VaultError::Invariant {
                context: format!(
                    "the parts of line `{id}` add up to {sum} and the line is {amount}: \
                     a line's categories add up to its amount"
                ),
            });
        }
    }
    Ok(())
}

/// What a purge does with the parts filed under a category it is about to remove (E3, the case
/// `PurgeRule::Drop` leaves to Money): **every part is filed again under the category's group when
/// it has one that is not in the trash, so the line keeps summing and keeps its other parts, and
/// two parts left under one category become one (amounts added, the first one's memo, in order);
/// when it has none, every part of such a line goes and the line is uncategorised.** Trashing a
/// category changes no line. A purge is never refused for it. The `Drop` that follows deletes what
/// is left naming the category.
pub(crate) fn refile_parts_of(ctx: &CommandCtx<'_, '_>, category: &str) -> Result<()> {
    let connection = ctx.connection();
    let group: Option<String> = connection
        .query_row(
            "SELECT g.id FROM entity c JOIN entity g ON g.id = c.parent_id
              WHERE c.id = ?1 AND g.deleted_at IS NULL",
            [category],
            |row| row.get(0),
        )
        .optional()?;
    let Some(group) = &group else {
        connection.execute(
            "DELETE FROM txn_split WHERE txn_id IN (SELECT txn_id FROM txn_split WHERE category_id = ?1)",
            [category],
        )?;
        return Ok(());
    };
    refile_parts_into(ctx, category, group)
}

/// File every part that names `from` under `into` instead, so each line keeps summing and keeps
/// its other parts; two parts left under one category become one (amounts added, the first one's
/// memo, in order).
pub(crate) fn refile_parts_into(ctx: &CommandCtx<'_, '_>, from: &str, into: &str) -> Result<()> {
    let connection = ctx.connection();
    let lines: Vec<String> = connection
        .prepare_cached("SELECT DISTINCT txn_id FROM txn_split WHERE category_id = ?1")?
        .query_map([from], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in lines {
        let mut merged: Vec<Part> = Vec::new();
        for mut part in parts_of(connection, &id)? {
            if part.category_id == from {
                part.category_id = into.to_owned();
            }
            match merged
                .iter_mut()
                .find(|m| m.category_id == part.category_id)
            {
                Some(first) => first.amount_minor += part.amount_minor,
                None => merged.push(part),
            }
        }
        write_parts(connection, &id, &merged)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// A line by hand
// ---------------------------------------------------------------------------

fn is_currency_code(text: &str) -> bool {
    text.len() == 3 && text.chars().all(|c| c.is_ascii_uppercase())
}

/// The sentence for an `original_*` pair that is half stated or not a currency.
fn original_sentence(amount: Option<i64>, currency: Option<&str>) -> Option<String> {
    match (amount, currency) {
        (None, None) => None,
        (Some(_), Some(code)) if is_currency_code(code) => None,
        (Some(_), Some(_)) => Some("A currency is a three-letter code like USD.".to_owned()),
        _ => Some("What was charged needs both its amount and its currency.".to_owned()),
    }
}

#[derive(serde::Deserialize)]
struct AddInput {
    id: Option<String>,
    account_id: String,
    posted_on: String,
    amount_minor: i64,
    title: Option<String>,
    memo: Option<String>,
    status: Option<String>,
    category_id: Option<String>,
    splits: Option<Vec<Part>>,
    original_amount_minor: Option<i64>,
    original_currency: Option<String>,
}

impl AddInput {
    /// The parts the input asks for: the one category the whole line is filed under, or the split.
    fn parts(&self) -> Vec<Part> {
        match (&self.splits, &self.category_id) {
            (Some(parts), _) => parts.clone(),
            (None, Some(category)) => vec![Part {
                category_id: category.clone(),
                amount_minor: self.amount_minor,
                memo: None,
            }],
            (None, None) => Vec::new(),
        }
    }
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let input: AddInput = ctx.parse_input()?;
    if let Some(id) = input.id.as_deref()
        && !is_free(connection, id)?
    {
        return Ok(Some(
            "A transaction with that id already exists.".to_owned(),
        ));
    }
    if !is_live(connection, &input.account_id, Kind::Account)? {
        return Ok(Some("There is no such account.".to_owned()));
    }
    if !is_day(connection, &input.posted_on)? {
        return Ok(Some("That is not a real date.".to_owned()));
    }
    if let Some(sentence) = original_sentence(
        input.original_amount_minor,
        input.original_currency.as_deref(),
    ) {
        return Ok(Some(sentence));
    }
    if input.splits.is_some() && input.category_id.is_some() {
        return Ok(Some(
            "File a line under one category or split it, not both.".to_owned(),
        ));
    }
    parts_sentence(connection, input.amount_minor, &input.parts())
}

/// `txn.add`: a line entered by hand, on any account. A one-time import of lines that is not a
/// statement follow (a CSV from another app) is an arrival (`arrived_via` and `arrived_label`);
/// its lines are hand lines the member can edit.
fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let title = crate::commands::money::squash(input.title.as_deref().unwrap_or_default());
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_in(id, Kind::Txn, &title, None)?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(Kind::Txn, &title, None)?,
    };
    connection.execute(
        "INSERT INTO txn (id, account_id, posted_on, amount_minor, status, entered, memo,
                          original_amount_minor, original_currency)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'posted'), 'hand', ?6, ?7, ?8)",
        rusqlite::params![
            id,
            input.account_id,
            input.posted_on,
            input.amount_minor,
            input.status,
            input.memo,
            input.original_amount_minor,
            input.original_currency,
        ],
    )?;
    write_parts(connection, &id, &input.parts())?;
    arrival::record(ctx, &id, Kind::Txn)?;
    Ok(json!({ "id": id }))
}

#[derive(serde::Deserialize)]
struct EditInput {
    id: String,
    posted_on: Option<String>,
    amount_minor: Option<i64>,
    account_id: Option<String>,
    status: Option<String>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    memo: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    original_amount_minor: Option<Option<i64>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    original_currency: Option<Option<String>>,
    splits: Option<Vec<Part>>,
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let input: EditInput = ctx.parse_input()?;
    let Some(held) = line(connection, &input.id)? else {
        return Ok(Some("That is not a transaction.".to_owned()));
    };
    if let Some(day) = input.posted_on.as_deref()
        && !is_day(connection, day)?
    {
        return Ok(Some("That is not a real date.".to_owned()));
    }
    if let Some(account) = input.account_id.as_deref() {
        if !is_live(connection, account, Kind::Account)? {
            return Ok(Some("There is no such account.".to_owned()));
        }
        if account != held.account_id && held.in_transfer {
            return Ok(Some(
                "A line in a transfer stays in its account: unlink the transfer first.".to_owned(),
            ));
        }
    }
    if let Some(amount) = input.amount_minor
        && held.in_transfer
        && (amount < 0) != (held.amount_minor < 0)
    {
        return Ok(Some(
            "A line in a transfer keeps its direction: unlink the transfer first.".to_owned(),
        ));
    }
    // What was charged, as the line will hold it: what is stated over what it holds.
    if input.original_amount_minor.is_some() || input.original_currency.is_some() {
        let amount = input
            .original_amount_minor
            .unwrap_or(held.original_amount_minor);
        let currency = input
            .original_currency
            .clone()
            .unwrap_or_else(|| held.original_currency.clone());
        if let Some(sentence) = original_sentence(amount, currency.as_deref()) {
            return Ok(Some(sentence));
        }
    }
    let amount = input.amount_minor.unwrap_or(held.amount_minor);
    match &input.splits {
        Some(parts) => parts_sentence(connection, amount, parts),
        None if amount != held.amount_minor && held.parts > 1 => Ok(Some(
            "This line is split: say how the new amount is split.".to_owned(),
        )),
        None => Ok(None),
    }
}

/// `txn.edit`: change a line. The answer carries the revision the next save names.
fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let id = input.id.as_str();
    let held = line(connection, id)?.ok_or_else(|| VaultError::Invariant {
        context: format!("`{id}` is not a line, and a precondition said it was"),
    })?;
    let mut changed = false;
    let mut set = |column: &str, value: rusqlite::types::Value| -> Result<()> {
        changed |= connection.execute(
            &format!("UPDATE txn SET {column} = ?2 WHERE id = ?1 AND {column} IS NOT ?2"),
            rusqlite::params![id, value],
        )? > 0;
        Ok(())
    };
    if let Some(day) = input.posted_on {
        set("posted_on", day.into())?;
    }
    if let Some(amount) = input.amount_minor {
        set("amount_minor", amount.into())?;
    }
    if let Some(account) = input.account_id {
        set("account_id", account.into())?;
    }
    if let Some(status) = input.status {
        set("status", status.into())?;
    }
    if let Some(memo) = input.memo {
        set(
            "memo",
            memo.map_or(rusqlite::types::Value::Null, Into::into),
        )?;
    }
    if input.original_amount_minor.is_some() || input.original_currency.is_some() {
        // The pair is one fact: both change in one statement (the table holds them both or neither).
        let amount = input
            .original_amount_minor
            .unwrap_or(held.original_amount_minor);
        let currency = input
            .original_currency
            .clone()
            .unwrap_or_else(|| held.original_currency.clone());
        changed |= connection.execute(
            "UPDATE txn SET original_amount_minor = ?2, original_currency = ?3
              WHERE id = ?1 AND (original_amount_minor, original_currency) IS NOT (?2, ?3)",
            rusqlite::params![id, amount, currency],
        )? > 0;
    }
    match input.splits {
        Some(parts) => {
            if parts_of(connection, id)? != parts {
                write_parts(connection, id, &parts)?;
                changed = true;
            }
        }
        // One part follows the amount it was the whole of; a split names its own (the precondition).
        None => {
            if let Some(amount) = input
                .amount_minor
                .filter(|amount| *amount != held.amount_minor)
                && held.parts == 1
            {
                connection.execute(
                    "UPDATE txn_split SET amount_minor = ?2 WHERE txn_id = ?1",
                    rusqlite::params![id, amount],
                )?;
            }
        }
    }
    if changed {
        ctx.touch(id)?;
    }
    with_rev(ctx, id, json!({ "id": id, "changed": changed }))
}

// ---------------------------------------------------------------------------
// Categories of a line
// ---------------------------------------------------------------------------

/// File a whole line under one category (the one part it had keeps its words). Whether anything
/// changed.
pub(crate) fn file_whole(connection: &Connection, id: &str, category: &str) -> Result<bool> {
    let Some(found) = line(connection, id)? else {
        return Ok(false);
    };
    let before = parts_of(connection, id)?;
    let after = vec![Part {
        category_id: category.to_owned(),
        amount_minor: found.amount_minor,
        memo: match before.as_slice() {
            [only] => only.memo.clone(),
            _ => None,
        },
    }];
    if before == after {
        return Ok(false);
    }
    write_parts(connection, id, &after)?;
    Ok(true)
}

fn ids_of(ctx: &CommandCtx<'_, '_>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ctx.input
        .get("ids")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .filter(|id| seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

fn pre_categorize(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    for id in ids_of(ctx) {
        if line(connection, &id)?.is_none() {
            return Ok(Some("One of those is not a transaction.".to_owned()));
        }
    }
    match ctx.optional_str("category_id") {
        Some(category) => fileable(connection, category),
        None => Ok(None),
    }
}

#[derive(serde::Deserialize)]
struct CategorizeInput {
    ids: Vec<String>,
    category_id: Option<String>,
}

/// File lines under one category (every part of a split line goes to it as one), or under none.
fn categorize(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: CategorizeInput = ctx.parse_input()?;
    let mut seen = BTreeSet::new();
    let ids: Vec<String> = input
        .ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let connection = ctx.connection();
    let mut changed = Vec::new();
    // What each changed line held, kept only while every one held at most one part and the same
    // one: then the act is taken back by filing those lines under it again.
    let mut held: Option<Option<String>> = None;
    let mut uniform = true;
    for id in &ids {
        let Some(found) = line(connection, id)? else {
            continue;
        };
        let before = parts_of(connection, id)?;
        let target = input.category_id.as_ref().map(|category| Part {
            category_id: category.clone(),
            amount_minor: found.amount_minor,
            // One part keeps the words it had; a split's parts fold into one and their words go.
            memo: match before.as_slice() {
                [only] => only.memo.clone(),
                _ => None,
            },
        });
        let after: Vec<Part> = target.into_iter().collect();
        if before == after {
            continue;
        }
        write_parts(connection, id, &after)?;
        let was = match before.as_slice() {
            [] => Some(None),
            [only] => Some(Some(only.category_id.clone())),
            _ => None,
        };
        match (&held, was) {
            (_, None) => uniform = false,
            (Some(first), Some(was)) if *first != was => uniform = false,
            (None, Some(was)) => held = Some(was),
            _ => {}
        }
        changed.push(id.clone());
    }
    let replaced = match held {
        Some(category) if uniform => Some(json!({ "ids": changed, "category_id": category })),
        _ => None,
    };
    let answer = json!({ "changed": changed.len(), "replaced": replaced });
    // One line named is the record a revision is of: the answer carries the one the next save names.
    match ids.as_slice() {
        [only] => with_rev(ctx, only, answer),
        _ => Ok(answer),
    }
}

#[derive(serde::Deserialize)]
struct SplitInput {
    id: String,
    parts: Vec<Part>,
}

fn pre_split(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let input: SplitInput = ctx.parse_input()?;
    let Some(found) = line(ctx.connection(), &input.id)? else {
        return Ok(Some("That is not a transaction.".to_owned()));
    };
    parts_sentence(ctx.connection(), found.amount_minor, &input.parts)
}

/// `txn.split`: say the line's categories whole: one part, several, or none (uncategorised). The
/// parts add up to the line's amount. The answer names the parts it replaced, which is how the
/// act is taken back.
fn split(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: SplitInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let before = parts_of(connection, &input.id)?;
    if before == input.parts {
        return with_rev(
            ctx,
            &input.id,
            json!({ "changed": false, "replaced": null }),
        );
    }
    write_parts(connection, &input.id, &input.parts)?;
    ctx.touch(&input.id)?;
    let replaced = json!({
        "parts": before.iter().map(|part| json!({
            "category_id": part.category_id,
            "amount_minor": part.amount_minor,
            "memo": part.memo,
        })).collect::<Vec<_>>()
    });
    with_rev(
        ctx,
        &input.id,
        json!({ "changed": true, "replaced": replaced }),
    )
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/// Let go of a line's transfer, and so of the other half's.
fn end_transfer(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<usize> {
    Ok(ctx
        .connection()
        .execute("DELETE FROM transfer WHERE a = ?1 OR b = ?1", [id])?)
}

fn pre_line(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(unless(
        line(ctx.connection(), ctx.required_str("id")?)?.is_some(),
        "That is not a transaction.",
    ))
}

fn pre_transfer(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let (a, b) = (ctx.required_str("id")?, ctx.required_str("other_id")?);
    if a == b {
        return Ok(Some(
            "A transfer is between two different transactions.".to_owned(),
        ));
    }
    let (Some(first), Some(second)) = (line(connection, a)?, line(connection, b)?) else {
        return Ok(Some("Both must be transactions.".to_owned()));
    };
    if first.account_id == second.account_id {
        return Ok(Some(
            "A transfer moves money between two accounts.".to_owned(),
        ));
    }
    if (first.amount_minor < 0) == (second.amount_minor < 0) {
        return Ok(Some(
            "One side of a transfer is money out and the other money in.".to_owned(),
        ));
    }
    // The pair that already holds these two is not "another transfer".
    let pair: Option<(String, String)> = connection
        .query_row(
            "SELECT a, b FROM transfer WHERE a IN (?1, ?2) OR b IN (?1, ?2)",
            [a, b],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let elsewhere = pair.is_some_and(|(x, y)| !((x == a && y == b) || (x == b && y == a)));
    Ok(unless(
        !elsewhere,
        "One of those is already part of another transfer.",
    ))
}

#[derive(serde::Deserialize)]
struct LinkTransferInput {
    id: String,
    other_id: String,
}

/// Two lines are the two halves of one movement of the member's own money: one `transfer` row
/// holds the pair, the lower id first, so either half finds its partner. The halves may be in two
/// currencies.
fn link_transfer(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: LinkTransferInput = ctx.parse_input()?;
    let (one, other) = (input.id.as_str(), input.other_id.as_str());
    let (a, b) = if one < other {
        (one, other)
    } else {
        (other, one)
    };
    let linked = ctx.connection().execute(
        "INSERT INTO transfer (a, b) VALUES (?1, ?2) ON CONFLICT (a) DO NOTHING",
        [a, b],
    )? > 0;
    Ok(json!({ "linked": linked }))
}

#[derive(serde::Deserialize)]
struct TxnIdInput {
    id: String,
}

fn unlink_transfer(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: TxnIdInput = ctx.parse_input()?;
    // The other half, named before the link goes: linking the two again takes the act back.
    let other: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT CASE WHEN a = ?1 THEN b ELSE a END FROM transfer WHERE a = ?1 OR b = ?1",
            [input.id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let unlinked = end_transfer(ctx, &input.id)?;
    Ok(json!({
        "unlinked": unlinked,
        "replaced": other.map(|other| json!({ "other_id": other }))
    }))
}

// ---------------------------------------------------------------------------
// A statement that seems to be a hand line
// ---------------------------------------------------------------------------

/// A hand line and a statement line of one account that seem to be the same money.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub hand_id: String,
    pub statement_id: String,
}

/// The pairs of an account's hand lines and statement lines that seem to be one: the same amount,
/// at most [`MATCH_DAYS`] days apart, neither in the trash, and not a pair the member dismissed
/// (`txn.dismiss_match`, one `txn_match_dismissal` row, a seek of its primary key). **Only a proposal**: nothing is merged
/// until `txn.confirm_match`. One walk of the account's hand lines (`txn_hand_by_account`), each
/// with a seek of the days around it (`txn_by_account_day`).
///
/// # Errors
/// A database error.
pub fn proposed_matches(connection: &Connection, account_id: &str) -> Result<Vec<Proposal>> {
    let mut statement = connection.prepare_cached(PROPOSALS)?;
    let rows = statement
        .query_map(rusqlite::params![account_id, MATCH_DAYS], |row| {
            Ok(Proposal {
                hand_id: row.get(0)?,
                statement_id: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<Proposal>>>()?;
    let mut rows = rows;
    rows.sort_by(|a, b| (&a.hand_id, &a.statement_id).cmp(&(&b.hand_id, &b.statement_id)));
    Ok(rows)
}

/// The statement of [`proposed_matches`]; `money_walks.rs` plans it.
pub const PROPOSALS: &str = "SELECT h.id, s.id
   FROM txn h
   CROSS JOIN entity he ON he.id = h.id AND he.deleted_at IS NULL
   CROSS JOIN txn s ON s.account_id = h.account_id
             AND s.posted_on >= date(h.posted_on, '-' || ?2 || ' days')
             AND s.posted_on <= date(h.posted_on, '+' || ?2 || ' days')
             AND s.amount_minor = h.amount_minor AND s.entered = 'statement'
   JOIN entity se ON se.id = s.id AND se.deleted_at IS NULL
  WHERE h.account_id = ?1 AND h.entered = 'hand'
    AND NOT EXISTS (SELECT 1 FROM txn_match_dismissal d
                     WHERE d.hand_id = h.id AND d.statement_id = s.id)";

fn pre_confirm(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let (hand, statement) = (
        ctx.required_str("hand_id")?,
        ctx.required_str("statement_id")?,
    );
    let (Some(h), Some(s)) = (line(connection, hand)?, line(connection, statement)?) else {
        return Ok(Some("Both must be transactions.".to_owned()));
    };
    if h.entered != "hand" || s.entered != "statement" {
        return Ok(Some(
            "A statement line is confirmed against a line you entered by hand.".to_owned(),
        ));
    }
    if h.account_id != s.account_id {
        return Ok(Some("Both lines are in one account.".to_owned()));
    }
    if h.in_transfer || s.in_transfer {
        return Ok(Some(
            "A line in a transfer cannot be confirmed: unlink the transfer first.".to_owned(),
        ));
    }
    Ok(unless(
        h.parts <= 1 || h.amount_minor == s.amount_minor,
        "This line is split and the bank's amount is different: split it again first.",
    ))
}

#[derive(serde::Deserialize)]
struct ConfirmInput {
    hand_id: String,
    statement_id: String,
}

/// `txn.confirm_match`: the hand line the member entered IS the statement line. The statement's
/// amount, day, status and what was charged win; the hand line keeps its category, its memo and its
/// name (a blank one takes the bank's); the sources that stated the statement line state this one
/// from now on, and the statement's own row, which the hand line makes a duplicate of, is purged.
fn confirm(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ConfirmInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let (hand, statement) = (input.hand_id.as_str(), input.statement_id.as_str());
    let (day, amount, status, original_amount, original_currency, memo, title): (
        String,
        i64,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
        String,
    ) = connection.query_row(
        "SELECT t.posted_on, t.amount_minor, t.status, t.original_amount_minor, t.original_currency,
                t.memo, e.title
           FROM txn t JOIN entity e ON e.id = t.id WHERE t.id = ?1",
        [statement],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        },
    )?;
    // The statement's parts, kept only when the hand line has none of its own.
    let theirs = parts_of(connection, statement)?;
    let mine = parts_of(connection, hand)?;
    // While it is still a hand line the table lets its amount and day take the bank's.
    connection.execute(
        "UPDATE txn SET posted_on = ?2, amount_minor = ?3, status = ?4,
                        original_amount_minor = ?5, original_currency = ?6,
                        memo = COALESCE(memo, ?7)
          WHERE id = ?1",
        rusqlite::params![
            hand,
            day,
            amount,
            status,
            original_amount,
            original_currency,
            memo
        ],
    )?;
    connection.execute(
        "UPDATE entity SET title = ?2 WHERE id = ?1 AND trim(title) = ''",
        [hand, title.as_str()],
    )?;
    match mine.as_slice() {
        [_] => {
            connection.execute(
                "UPDATE txn_split SET amount_minor = ?2 WHERE txn_id = ?1",
                rusqlite::params![hand, amount],
            )?;
        }
        [] if !theirs.is_empty() => write_parts(connection, hand, &theirs)?,
        _ => {}
    }
    // The statement's own sources state the hand line now, and then its own row is a duplicate.
    connection.execute(
        "UPDATE source SET entity_id = ?1 WHERE entity_id = ?2",
        [hand, statement],
    )?;
    entity::purge_one(ctx, statement, &mut Vec::new())?;
    // A statement line is nobody's hand line any more: what it was told not to match goes.
    connection.execute("DELETE FROM txn_match_dismissal WHERE hand_id = ?1", [hand])?;
    connection.execute("UPDATE txn SET entered = 'statement' WHERE id = ?1", [hand])?;
    ctx.touch(hand)?;
    with_rev(ctx, hand, json!({ "id": hand }))
}

fn pre_dismiss(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let (hand, statement) = (
        ctx.required_str("hand_id")?,
        ctx.required_str("statement_id")?,
    );
    let (Some(h), Some(s)) = (line(connection, hand)?, line(connection, statement)?) else {
        return Ok(Some("Both must be transactions.".to_owned()));
    };
    if h.entered != "hand" || s.entered != "statement" {
        return Ok(Some(
            "Only a statement line against a line you entered by hand can be dismissed.".to_owned(),
        ));
    }
    Ok(unless(
        h.account_id == s.account_id,
        "Both lines are in one account.",
    ))
}

/// `txn.dismiss_match`: the member says this hand line and this statement line are NOT the same
/// money. The pair is kept (`txn_match_dismissal`) and [`proposed_matches`] leaves it out from now
/// on. Dismissing a pair twice is one dismissal.
fn dismiss(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ConfirmInput = ctx.parse_input()?;
    let dismissed = ctx.connection().execute(
        "INSERT INTO txn_match_dismissal (hand_id, statement_id) VALUES (?1, ?2)
         ON CONFLICT DO NOTHING",
        [input.hand_id.as_str(), input.statement_id.as_str()],
    )? > 0;
    Ok(json!({ "dismissed": dismissed }))
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

macro_rules! part_schema {
    () => {
        r#"{
          "type": "object",
          "required": ["category_id", "amount_minor"],
          "additionalProperties": false,
          "properties": {
            "category_id": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer" },
            "memo": { "type": ["string", "null"], "maxLength": 500 }
          }
        }"#
    };
}

const ADD_SCHEMA: &str = concat!(
    r#"{
      "type": "object",
      "required": ["account_id", "posted_on", "amount_minor"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "account_id": { "type": "string", "minLength": 1 },
        "posted_on": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        "amount_minor": { "type": "integer" },
        "title": { "type": "string", "maxLength": 200 },
        "memo": { "type": "string", "maxLength": 2000 },
        "status": { "enum": ["pending", "posted"] },
        "category_id": { "type": "string", "minLength": 1 },
        "splits": { "type": "array", "maxItems": 50, "items": "#,
    part_schema!(),
    r#" },
        "original_amount_minor": { "type": "integer" },
        "original_currency": { "type": "string", "minLength": 3, "maxLength": 3 },
        "arrived_via": { "enum": ["csv"] },
        "arrived_label": { "type": "string", "maxLength": 200 }
      }
    }"#
);

const EDIT_SCHEMA: &str = concat!(
    r#"{
      "type": "object",
      "required": ["id"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "posted_on": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        "amount_minor": { "type": "integer" },
        "account_id": { "type": "string", "minLength": 1 },
        "status": { "enum": ["pending", "posted"] },
        "memo": { "type": ["string", "null"], "maxLength": 2000 },
        "original_amount_minor": { "type": ["integer", "null"] },
        "original_currency": { "type": ["string", "null"], "minLength": 3, "maxLength": 3 },
        "splits": { "type": "array", "maxItems": 50, "items": "#,
    part_schema!(),
    r#" },
        "expected_rev": { "type": "integer", "minimum": 0 }
      }
    }"#
);

const SPLIT_SCHEMA: &str = concat!(
    r#"{
      "type": "object",
      "required": ["id", "parts"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "parts": { "type": "array", "maxItems": 50, "items": "#,
    part_schema!(),
    r#" },
        "expected_rev": { "type": "integer", "minimum": 0 }
      }
    }"#
);

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "line_is_sound",
        check: pre_add,
    }];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "line_edit_is_sound",
            check: pre_edit,
        },
    ];
    const CATEGORIZE: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "lines_can_be_filed",
            check: pre_categorize,
        },
    ];
    const SPLIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "parts_add_up_to_the_line",
            check: pre_split,
        },
    ];
    const LINE: &[CommandCondition] = &[CommandCondition {
        predicate: "transaction_exists",
        check: pre_line,
    }];
    const TRANSFER: &[CommandCondition] = &[CommandCondition {
        predicate: "lines_make_a_transfer",
        check: pre_transfer,
    }];
    const CONFIRM: &[CommandCondition] = &[CommandCondition {
        predicate: "a_statement_line_matches_a_hand_line",
        check: pre_confirm,
    }];

    const DISMISS: &[CommandCondition] = &[CommandCondition {
        predicate: "a_hand_line_and_a_statement_line_of_one_account",
        check: pre_dismiss,
    }];

    let mut confirm_match = CommandDefinition::plain(
        "txn.confirm_match",
        "txn",
        r#"{
          "type": "object",
          "required": ["hand_id", "statement_id"],
          "additionalProperties": false,
          "properties": {
            "hand_id": { "type": "string", "minLength": 1 },
            "statement_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        CONFIRM,
        confirm,
    );
    confirm_match.risk = Risk::Medium;

    vec![
        CommandDefinition::plain("txn.add", "txn", ADD_SCHEMA, Idempotency::Once, ADD, add),
        CommandDefinition::plain(
            "txn.edit",
            "txn",
            EDIT_SCHEMA,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "txn.categorize",
            "txn",
            r#"{
              "type": "object",
              "required": ["ids", "category_id"],
              "additionalProperties": false,
              "properties": {
                "ids": {
                  "type": "array", "minItems": 1, "maxItems": 2000,
                  "items": { "type": "string", "minLength": 1 }
                },
                "category_id": { "type": ["string", "null"], "minLength": 1 },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            CATEGORIZE,
            categorize,
        ),
        CommandDefinition::plain(
            "txn.split",
            "txn",
            SPLIT_SCHEMA,
            Idempotency::Idempotent,
            SPLIT,
            split,
        ),
        confirm_match,
        CommandDefinition::plain(
            "txn.dismiss_match",
            "txn",
            r#"{
              "type": "object",
              "required": ["hand_id", "statement_id"],
              "additionalProperties": false,
              "properties": {
                "hand_id": { "type": "string", "minLength": 1 },
                "statement_id": { "type": "string", "minLength": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            DISMISS,
            dismiss,
        ),
        CommandDefinition::plain(
            "txn.link_transfer",
            "txn",
            r#"{
              "type": "object",
              "required": ["id", "other_id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "other_id": { "type": "string", "minLength": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            TRANSFER,
            link_transfer,
        ),
        CommandDefinition::plain(
            "txn.unlink_transfer",
            "txn",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": { "id": { "type": "string", "minLength": 1 } }
            }"#,
            Idempotency::Idempotent,
            LINE,
            unlink_transfer,
        ),
    ]
}
