//! Money's verbs: an account, the lines of its statement, a month's plan, a
//! balance the bank stated, and the member's categories
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! Money reads a bank or card statement the member imported and says where it
//! went. **Nothing stored is a figure**: no balance, total or rollup is written;
//! a screen derives them at read time. What is written is a decision (a name, a
//! category, a plan, a rule) or a fact the bank stated (a line, a checkpoint).
//!
//! - **An account** is an entity with a currency, a type and the balance it
//!   opened with. Its bank number, when it has one, and the column layout its
//!   statements were last read with live on the **statement origin** that fills
//!   it (`origin.ref`, `origin.config`); with no number the origin's `ref` is the
//!   account's own id, so every account has exactly one origin from birth.
//!   Closing is the `archived` flag and a rename is `entity.retitle`: nothing
//!   here duplicates a shared verb.
//! - **A line** is `follow.statement`'s: the vault adds a line once, a re-import
//!   writes nothing, and a line is never edited (the schema refuses it). Money's
//!   own verbs on a line are a category, a void and a transfer. **The amount is
//!   signed: money out is negative.**
//! - **A category** is a concept; a group is a category with no parent. Its id is
//!   its key, so asking for a category that exists is the same ask.
//! - **A plan** (`budget`) is a category's amount for a month, and a checkpoint is
//!   a balance the bank stated that a derived balance is compared with.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::entity;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::Result;
use crate::model::{Flag, Kind, concept_id, fold_label};

/// The vocabulary of `account.type`, held equal to the CHECK by a test.
pub const ACCOUNT_TYPES: [&str; 4] = ["checking", "savings", "credit_card", "cash"];

/// The vocabulary of `txn.status`, held equal to the CHECK by a test.
pub const TXN_STATUSES: [&str; 3] = ["pending", "posted", "void"];

/// The most lines one `txn.categorize` names.
pub const CATEGORIZE_MAX: usize = 2_000;

// ---------------------------------------------------------------------------
// Small helpers. SQL lives in `crates/vault` by construction.
// ---------------------------------------------------------------------------

fn unless(ok: bool, sentence: &str) -> Option<String> {
    (!ok).then(|| sentence.to_owned())
}

/// Whether `id` names a live entity of this kind.
pub(crate) fn is_live(connection: &Connection, id: &str, kind: Kind) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity WHERE id = ?1 AND kind = ?2 AND deleted_at IS NULL)",
        [id, kind.as_str()],
        |row| row.get(0),
    )?)
}

fn is_archived(connection: &Connection, id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM edge WHERE from_id = ?1 AND rel = 'tagged' AND to_id = ?2)",
        [id, &Flag::Archived.id()],
        |row| row.get(0),
    )?)
}

fn is_free(connection: &Connection, id: &str) -> Result<bool> {
    Ok(!connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity WHERE id = ?1)",
        [id],
        |row| row.get::<_, bool>(0),
    )?)
}

/// Whether the text is a real day, `YYYY-MM-DD`.
pub(crate) fn is_day(connection: &Connection, text: &str) -> Result<bool> {
    Ok(connection.query_row("SELECT date(?1) IS ?1", [text], |row| row.get(0))?)
}

fn is_month(connection: &Connection, text: &str) -> Result<bool> {
    is_day(connection, &format!("{text}-01"))
}

fn flag(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<bool> {
    ctx.input.get(key).and_then(Json::as_bool)
}

fn integer(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<i64> {
    ctx.input.get(key).and_then(Json::as_i64)
}

/// A name with its runs of whitespace collapsed.
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether a category, live and not archived, is there to file a line under.
pub(crate) fn fileable(connection: &Connection, id: &str) -> Result<Option<String>> {
    if !is_live(connection, id, Kind::Category)? {
        return Ok(Some("There is no such category.".to_owned()));
    }
    Ok(is_archived(connection, id)?
        .then(|| "That category is archived. Unarchive it first.".to_owned()))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// The bank number as an origin's `ref`: the number, or the account's own id.
fn origin_ref(account_id: &str, number: Option<&str>) -> String {
    number
        .map(str::trim)
        .filter(|number| !number.is_empty())
        .unwrap_or(account_id)
        .to_owned()
}

fn number_is_taken(connection: &Connection, number: &str, except: Option<&str>) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM origin WHERE system = 'statement' AND ref = ?1
                           AND fills IS NOT ?2)",
        rusqlite::params![number.trim(), except],
        |row| row.get(0),
    )?)
}

fn name_is_taken(connection: &Connection, name: &str, except: Option<&str>) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM account a JOIN entity e ON e.id = a.id
                         WHERE e.deleted_at IS NULL AND a.id IS NOT ?2
                           AND lower(trim(e.title)) = lower(trim(?1)))",
        rusqlite::params![name, except],
        |row| row.get(0),
    )?)
}

fn pre_new_account(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if let Some(id) = ctx.optional_str("id")
        && !is_free(connection, id)?
    {
        return Ok(Some("An account with that id already exists.".to_owned()));
    }
    let name = squash(ctx.required_str("title")?);
    if name.is_empty() {
        return Ok(Some("An account needs a name.".to_owned()));
    }
    if name_is_taken(connection, &name, None)? {
        return Ok(Some(
            "You already have an account with that name.".to_owned(),
        ));
    }
    if let Some(currency) = ctx.optional_str("currency")
        && currency.trim().len() != 3
    {
        return Ok(Some(
            "A currency is a three-letter code like USD.".to_owned(),
        ));
    }
    if let Some(number) = ctx.optional_str("external_ref")
        && !number.trim().is_empty()
        && number_is_taken(connection, number, None)?
    {
        return Ok(Some(
            "Another account already has that bank number.".to_owned(),
        ));
    }
    Ok(None)
}

fn add_account(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let title = squash(ctx.required_str("title")?);
    let id = match ctx.optional_str("id") {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Account, &title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Account, &title)?,
    };
    let currency = match ctx.optional_str("currency") {
        Some(currency) => currency.trim().to_uppercase(),
        None => connection.query_row("SELECT currency FROM vault", [], |row| row.get(0))?,
    };
    connection.execute(
        "INSERT INTO account (id, type, currency, opening_minor, on_budget)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            id,
            ctx.required_str("type")?,
            currency,
            integer(ctx, "opening_minor").unwrap_or(0),
            i64::from(flag(ctx, "on_budget").unwrap_or(true)),
        ],
    )?;
    connection.execute(
        "INSERT INTO origin (id, system, ref, label, fills, created_at)
         VALUES (?1, 'statement', ?2, ?3, ?4, ?5)",
        rusqlite::params![
            ctx.next_id(),
            origin_ref(&id, ctx.optional_str("external_ref")),
            title,
            id,
            ctx.now
        ],
    )?;
    Ok(json!({ "id": id, "currency": currency }))
}

/// checking and savings are one class; a card and cash are others.
fn class(account_type: &str) -> u8 {
    match account_type {
        "credit_card" => 1,
        "cash" => 2,
        _ => 0,
    }
}

fn pre_account(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let id = ctx.required_str("id")?;
    Ok(unless(
        is_live(ctx.connection(), id, Kind::Account)?,
        "There is no such account.",
    ))
}

fn pre_edit_account(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_account(ctx)? {
        return Ok(Some(sentence));
    }
    let connection = ctx.connection();
    let id = ctx.required_str("id")?;
    if let Some(title) = ctx.optional_str("title") {
        let name = squash(title);
        if name.is_empty() {
            return Ok(Some("An account needs a name.".to_owned()));
        }
        if name_is_taken(connection, &name, Some(id))? {
            return Ok(Some(
                "You already have an account with that name.".to_owned(),
            ));
        }
    }
    if let Some(wanted) = ctx.optional_str("type") {
        let current: String =
            connection.query_row("SELECT type FROM account WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        if class(wanted) != class(&current) {
            return Ok(Some(
                "An account can change between checking and savings; a card or cash is its own kind of account."
                    .to_owned(),
            ));
        }
    }
    if let Some(number) = ctx.optional_str("external_ref")
        && !number.trim().is_empty()
        && number_is_taken(connection, number, Some(id))?
    {
        return Ok(Some(
            "Another account already has that bank number.".to_owned(),
        ));
    }
    Ok(None)
}

fn edit_account(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let id = ctx.required_str("id")?;
    let mut changed = false;
    if let Some(title) = ctx.optional_str("title") {
        let name = squash(title);
        changed |= connection.execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1 AND title IS NOT ?2",
            [id, &name],
        )? > 0;
        // The origin is labelled by the account's name.
        connection.execute(
            "UPDATE origin SET label = ?2 WHERE system = 'statement' AND fills = ?1",
            [id, &name],
        )?;
    }
    if let Some(account_type) = ctx.optional_str("type") {
        changed |= connection.execute(
            "UPDATE account SET type = ?2 WHERE id = ?1 AND type IS NOT ?2",
            [id, account_type],
        )? > 0;
    }
    if let Some(budget) = flag(ctx, "on_budget") {
        changed |= connection.execute(
            "UPDATE account SET on_budget = ?2 WHERE id = ?1 AND on_budget IS NOT ?2",
            rusqlite::params![id, i64::from(budget)],
        )? > 0;
    }
    if let Some(number) = ctx.input.get("external_ref") {
        changed |= connection.execute(
            "UPDATE origin SET ref = ?2 WHERE system = 'statement' AND fills = ?1 AND ref IS NOT ?2",
            rusqlite::params![id, origin_ref(id, number.as_str())],
        )? > 0;
    }
    if changed {
        ctx.touch(id)?;
    }
    Ok(json!({ "id": id, "changed": changed }))
}

fn set_opening(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let changed = ctx.connection().execute(
        "UPDATE account SET opening_minor = ?2 WHERE id = ?1 AND opening_minor IS NOT ?2",
        rusqlite::params![id, integer(ctx, "opening_minor").unwrap_or(0)],
    )? > 0;
    if changed {
        ctx.touch(id)?;
    }
    Ok(json!({ "id": id, "changed": changed }))
}

fn pre_layout(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_account(ctx)? {
        return Ok(Some(sentence));
    }
    let layout = ctx.input.get("layout").cloned().unwrap_or(Json::Null);
    let has = |key: &str| layout.get(key).is_some_and(|value| !value.is_null());
    let missing = match layout.get("sign_mode").and_then(Json::as_str) {
        Some("debit_credit") => !(has("debit_col") && has("credit_col")),
        Some("indicator") => {
            !(has("amount_col") && has("indicator_col") && has("indicator_out_value"))
        }
        _ => !has("amount_col"),
    };
    Ok(missing.then(|| "This layout does not say which columns hold the amount.".to_owned()))
}

/// Remember how the account's statements are laid out, for the next one.
fn remember_layout(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let layout = ctx.input.get("layout").cloned().unwrap_or(Json::Null);
    let saved = ctx.connection().execute(
        "UPDATE origin SET config = ?2
          WHERE system = 'statement' AND fills = ?1 AND config IS NOT ?2",
        rusqlite::params![ctx.required_str("id")?, layout.to_string()],
    )? > 0;
    Ok(json!({ "saved": saved }))
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/// A live line that is not void: what a category or a transfer can be set on.
struct Line {
    account_id: String,
    currency: String,
    amount_minor: i64,
    status: String,
    transfer_id: Option<String>,
}

fn line(connection: &Connection, id: &str) -> Result<Option<Line>> {
    Ok(connection
        .query_row(
            "SELECT t.account_id, t.currency, t.amount_minor, t.status, t.transfer_id
               FROM txn t JOIN entity e ON e.id = t.id
              WHERE t.id = ?1 AND e.deleted_at IS NULL",
            [id],
            |row| {
                Ok(Line {
                    account_id: row.get(0)?,
                    currency: row.get(1)?,
                    amount_minor: row.get(2)?,
                    status: row.get(3)?,
                    transfer_id: row.get(4)?,
                })
            },
        )
        .optional()?)
}

fn ids_of(ctx: &CommandCtx<'_, '_>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
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
        match line(connection, &id)? {
            None => return Ok(Some("One of those is not a transaction.".to_owned())),
            Some(found) if found.status == "void" => {
                return Ok(Some("A removed transaction cannot be filed.".to_owned()));
            }
            Some(_) => {}
        }
    }
    match ctx.optional_str("category_id") {
        Some(category) => fileable(connection, category),
        None => Ok(None),
    }
}

fn categorize(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let category = ctx.optional_str("category_id");
    let mut changed = 0;
    for id in ids_of(ctx) {
        if ctx.connection().execute(
            "UPDATE txn SET category_id = ?2 WHERE id = ?1 AND category_id IS NOT ?2",
            rusqlite::params![id, category],
        )? > 0
        {
            ctx.touch(&id)?;
            changed += 1;
        }
    }
    Ok(json!({ "changed": changed }))
}

/// Let go of a line's transfer, and of the other half's.
fn end_transfer(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<usize> {
    let touched: Vec<String> = ctx
        .connection()
        .prepare_cached(
            "SELECT id FROM txn WHERE id = ?1 AND transfer_id IS NOT NULL OR transfer_id = ?1",
        )?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for member in &touched {
        ctx.connection()
            .execute("UPDATE txn SET transfer_id = NULL WHERE id = ?1", [member])?;
        ctx.touch(member)?;
    }
    Ok(touched.len())
}

fn pre_line(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(unless(
        line(ctx.connection(), ctx.required_str("id")?)?.is_some(),
        "That is not a transaction.",
    ))
}

fn void(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    // A removed line is no half of a transfer.
    let ended = end_transfer(ctx, id)?;
    let voided = ctx.connection().execute(
        "UPDATE txn SET status = 'void' WHERE id = ?1 AND status <> 'void'",
        [id],
    )? > 0;
    if voided {
        ctx.touch(id)?;
    }
    Ok(json!({ "voided": voided, "transfers_ended": ended }))
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
    if first.status == "void" || second.status == "void" {
        return Ok(Some(
            "A removed transaction cannot be part of a transfer.".to_owned(),
        ));
    }
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
    if first.currency != second.currency {
        return Ok(Some(
            "Both sides of a transfer are in the same currency.".to_owned(),
        ));
    }
    let elsewhere =
        |found: &Line, other: &str| found.transfer_id.as_deref().is_some_and(|t| t != other);
    Ok(unless(
        !(elsewhere(&first, b) || elsewhere(&second, a)),
        "One of those is already part of another transfer.",
    ))
}

/// Two lines are the two halves of one movement of the member's own money; each
/// points at the other, so either half finds its partner.
fn link_transfer(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (a, b) = (ctx.required_str("id")?, ctx.required_str("other_id")?);
    let mut linked = false;
    for (from, to) in [(a, b), (b, a)] {
        if ctx.connection().execute(
            "UPDATE txn SET transfer_id = ?2 WHERE id = ?1 AND transfer_id IS NOT ?2",
            [from, to],
        )? > 0
        {
            ctx.touch(from)?;
            linked = true;
        }
    }
    Ok(json!({ "linked": linked }))
}

fn unlink_transfer(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    Ok(json!({ "unlinked": end_transfer(ctx, ctx.required_str("id")?)? }))
}

// ---------------------------------------------------------------------------
// Plans and checkpoints
// ---------------------------------------------------------------------------

fn pre_plan(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if !is_month(connection, ctx.required_str("month")?)? {
        return Ok(Some("That is not a real month.".to_owned()));
    }
    if !is_live(connection, ctx.required_str("category_id")?, Kind::Category)? {
        return Ok(Some("There is no such category.".to_owned()));
    }
    if let Some(currency) = ctx.optional_str("currency")
        && currency.trim().len() != 3
    {
        return Ok(Some(
            "A currency is a three-letter code like USD.".to_owned(),
        ));
    }
    Ok(None)
}

fn set_plan(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (month, category) = (ctx.required_str("month")?, ctx.required_str("category_id")?);
    let Some(amount) = integer(ctx, "amount_minor") else {
        // `null` removes the plan for that month.
        let removed = ctx.connection().execute(
            "DELETE FROM budget WHERE month = ?1 AND category_id = ?2",
            [month, category],
        )? > 0;
        return Ok(json!({ "changed": removed }));
    };
    let currency = match ctx.optional_str("currency") {
        Some(currency) => currency.trim().to_uppercase(),
        None => ctx
            .connection()
            .query_row("SELECT currency FROM vault", [], |row| row.get(0))?,
    };
    let carry = flag(ctx, "carry").map(i64::from);
    let changed = ctx.connection().execute(
        "INSERT INTO budget (category_id, month, amount_minor, currency, carry)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 0))
         ON CONFLICT (category_id, month) DO UPDATE SET
           amount_minor = excluded.amount_minor,
           currency = excluded.currency,
           carry = COALESCE(?5, budget.carry)
         WHERE budget.amount_minor IS NOT excluded.amount_minor
            OR budget.currency IS NOT excluded.currency
            OR (?5 IS NOT NULL AND budget.carry IS NOT ?5)",
        rusqlite::params![category, month, amount, currency, carry],
    )? > 0;
    Ok(json!({ "changed": changed }))
}

fn pre_carry(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if !is_month(connection, ctx.required_str("month")?)? {
        return Ok(Some("That is not a real month.".to_owned()));
    }
    let found: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM budget WHERE month = ?1 AND category_id = ?2)",
        [ctx.required_str("month")?, ctx.required_str("category_id")?],
        |row| row.get(0),
    )?;
    Ok(unless(found, "Set an amount for that month first."))
}

fn set_carry(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let changed = ctx.connection().execute(
        "UPDATE budget SET carry = ?1 WHERE month = ?2 AND category_id = ?3 AND carry IS NOT ?1",
        rusqlite::params![
            i64::from(flag(ctx, "carry").unwrap_or(false)),
            ctx.required_str("month")?,
            ctx.required_str("category_id")?
        ],
    )? > 0;
    Ok(json!({ "changed": changed }))
}

fn pre_checkpoint(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_account_at(ctx, "account_id")? {
        return Ok(Some(sentence));
    }
    Ok(unless(
        is_day(ctx.connection(), ctx.required_str("day")?)?,
        "That is not a real date.",
    ))
}

fn pre_account_at(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<Option<String>> {
    Ok(unless(
        is_live(ctx.connection(), ctx.required_str(key)?, Kind::Account)?,
        "There is no such account.",
    ))
}

/// A balance the bank stated on a day. Stating it again, or differently, is the
/// same row: the latest word for the day stands.
fn record_checkpoint(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let written = ctx.connection().execute(
        "INSERT INTO checkpoint (account_id, day, balance_minor) VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id, day) DO UPDATE SET balance_minor = excluded.balance_minor
          WHERE checkpoint.balance_minor IS NOT excluded.balance_minor",
        rusqlite::params![
            ctx.required_str("account_id")?,
            ctx.required_str("day")?,
            integer(ctx, "balance_minor").unwrap_or(0)
        ],
    )? > 0;
    Ok(json!({ "written": written }))
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

fn pre_new_category(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let title = squash(ctx.required_str("title")?);
    if fold_label(&title).is_empty() {
        return Ok(Some("A category needs a name.".to_owned()));
    }
    let parent_key = match ctx.optional_str("parent_id") {
        None => None,
        Some(parent) => {
            // Two levels: a category goes under a group, and a group under nothing.
            if !is_live(connection, parent, Kind::Category)? {
                return Ok(Some("There is no such group.".to_owned()));
            }
            let held: Option<(String, Option<String>)> = connection
                .query_row(
                    "SELECT key, parent_id FROM concept WHERE id = ?1",
                    [parent],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            match held {
                Some((key, None)) => Some(key),
                _ => {
                    return Ok(Some(
                        "A category goes under a group, not under another category.".to_owned(),
                    ));
                }
            }
        }
    };
    let key = category_key(parent_key.as_deref(), &title);
    let taken: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM concept WHERE kind = 'category' AND key = ?1)",
        [&key],
        |row| row.get(0),
    )?;
    Ok(unless(
        !taken,
        "There is already a category with that name there.",
    ))
}

/// A category's key: its folded name, under its group's key when it has one.
fn category_key(group: Option<&str>, title: &str) -> String {
    match group {
        Some(group) => format!("{group}.{}", fold_label(title)),
        None => fold_label(title),
    }
}

fn add_category(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let parent = ctx.optional_str("parent_id");
    let group_key: Option<String> = match parent {
        Some(parent) => Some(connection.query_row(
            "SELECT key FROM concept WHERE id = ?1",
            [parent],
            |row| row.get(0),
        )?),
        None => None,
    };
    let title = squash(ctx.required_str("title")?);
    let key = category_key(group_key.as_deref(), &title);
    let id = concept_id(Kind::Category, &key);
    ctx.insert_entity_as(&id, Kind::Category, &title)?;
    connection.execute(
        "INSERT INTO concept (id, kind, key, parent_id) VALUES (?1, 'category', ?2, ?3)",
        rusqlite::params![id, key, parent],
    )?;
    Ok(json!({ "id": id }))
}

fn pre_merge_category(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let (from, into) = (ctx.required_str("from_id")?, ctx.required_str("into_id")?);
    if !(is_live(connection, from, Kind::Category)? && is_live(connection, into, Kind::Category)?) {
        return Ok(Some("There is no such category.".to_owned()));
    }
    if from == into {
        return Ok(Some(
            "Choose a different category to merge into.".to_owned(),
        ));
    }
    let children: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM concept WHERE parent_id = ?1)",
        [from],
        |row| row.get(0),
    )?;
    Ok(unless(
        !children,
        "Merge or move the categories inside it first.",
    ))
}

/// Fold one category into another: its lines, its rules and its plans move, and
/// it goes. Where both planned the same month (in one currency) the plans add.
fn merge_category(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let (from, into) = (ctx.required_str("from_id")?, ctx.required_str("into_id")?);
    let lines: Vec<String> = connection
        .prepare("SELECT id FROM txn WHERE category_id = ?1")?
        .query_map([from], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &lines {
        connection.execute("UPDATE txn SET category_id = ?2 WHERE id = ?1", [id, into])?;
        ctx.touch(id)?;
    }
    let rules = connection.execute(
        "UPDATE rule SET category_id = ?2 WHERE category_id = ?1",
        [from, into],
    )?;
    let plans: Vec<(String, i64, String, i64)> = connection
        .prepare("SELECT month, amount_minor, currency, carry FROM budget WHERE category_id = ?1")?
        .query_map([from], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (month, amount, currency, carry) in &plans {
        let held: Option<String> = connection
            .query_row(
                "SELECT currency FROM budget WHERE category_id = ?1 AND month = ?2",
                [into, month],
                |row| row.get(0),
            )
            .optional()?;
        match held {
            None => {
                connection.execute(
                    "UPDATE budget SET category_id = ?3 WHERE category_id = ?1 AND month = ?2",
                    [from, month, into],
                )?;
            }
            Some(held) if &held == currency => {
                connection.execute(
                    "UPDATE budget SET amount_minor = amount_minor + ?3, carry = MAX(carry, ?4)
                      WHERE category_id = ?1 AND month = ?2",
                    rusqlite::params![into, month, amount, carry],
                )?;
            }
            Some(_) => {}
        }
    }
    // The category leaves; its plans left with it and its archive mark with it.
    entity::purge_one(ctx, from, &mut Vec::new())?;
    Ok(json!({ "transactions": lines.len(), "rules": rules, "plans": plans.len() }))
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const NEW_ACCOUNT: &[CommandCondition] = &[CommandCondition {
        predicate: "account_is_new_and_named",
        check: pre_new_account,
    }];
    const ACCOUNT: &[CommandCondition] = &[CommandCondition {
        predicate: "account_exists",
        check: pre_account,
    }];
    const EDIT_ACCOUNT: &[CommandCondition] = &[CommandCondition {
        predicate: "account_edit_is_sound",
        check: pre_edit_account,
    }];
    const LAYOUT: &[CommandCondition] = &[CommandCondition {
        predicate: "layout_names_its_columns",
        check: pre_layout,
    }];
    const CATEGORIZE: &[CommandCondition] = &[CommandCondition {
        predicate: "lines_can_be_filed",
        check: pre_categorize,
    }];
    const LINE: &[CommandCondition] = &[CommandCondition {
        predicate: "transaction_exists",
        check: pre_line,
    }];
    const TRANSFER: &[CommandCondition] = &[CommandCondition {
        predicate: "lines_make_a_transfer",
        check: pre_transfer,
    }];
    const PLAN: &[CommandCondition] = &[CommandCondition {
        predicate: "plan_is_for_a_month_and_a_category",
        check: pre_plan,
    }];
    const CARRY: &[CommandCondition] = &[CommandCondition {
        predicate: "plan_exists",
        check: pre_carry,
    }];
    const CHECKPOINT: &[CommandCondition] = &[CommandCondition {
        predicate: "checkpoint_is_for_an_account_and_a_day",
        check: pre_checkpoint,
    }];
    const NEW_CATEGORY: &[CommandCondition] = &[CommandCondition {
        predicate: "category_is_new_and_under_a_group",
        check: pre_new_category,
    }];
    const MERGE: &[CommandCondition] = &[CommandCondition {
        predicate: "categories_can_merge",
        check: pre_merge_category,
    }];

    let mut merge = CommandDefinition::plain(
        "category.merge",
        "category",
        r#"{
          "type": "object",
          "required": ["from_id", "into_id"],
          "additionalProperties": false,
          "properties": {
            "from_id": { "type": "string", "minLength": 1 },
            "into_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        MERGE,
        merge_category,
    );
    merge.risk = Risk::Medium;
    let mut void_line = CommandDefinition::plain(
        "txn.void",
        "txn",
        r#"{
          "type": "object",
          "required": ["id"],
          "additionalProperties": false,
          "properties": { "id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        LINE,
        void,
    );
    void_line.risk = Risk::Medium;

    vec![
        CommandDefinition::plain(
            "account.add",
            "account",
            r#"{
              "type": "object",
              "required": ["title", "type"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1, "maxLength": 80 },
                "type": { "enum": ["checking", "savings", "credit_card", "cash"] },
                "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
                "on_budget": { "type": "boolean" },
                "external_ref": { "type": "string", "minLength": 1, "maxLength": 64 },
                "opening_minor": { "type": "integer" }
              }
            }"#,
            Idempotency::Once,
            NEW_ACCOUNT,
            add_account,
        ),
        CommandDefinition::plain(
            "account.edit",
            "account",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1, "maxLength": 80 },
                "type": { "enum": ["checking", "savings", "credit_card", "cash"] },
                "on_budget": { "type": "boolean" },
                "external_ref": { "type": ["string", "null"], "minLength": 1, "maxLength": 64 }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT_ACCOUNT,
            edit_account,
        ),
        CommandDefinition::plain(
            "account.set_opening",
            "account",
            r#"{
              "type": "object",
              "required": ["id", "opening_minor"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "opening_minor": { "type": "integer" }
              }
            }"#,
            Idempotency::Idempotent,
            ACCOUNT,
            set_opening,
        ),
        CommandDefinition::plain(
            "account.remember_layout",
            "account",
            r#"{
              "type": "object",
              "required": ["id", "layout"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "layout": {
                  "type": "object",
                  "required": ["header_fingerprint", "delimiter", "date_order", "sign_mode", "date_col", "desc_col"],
                  "additionalProperties": false,
                  "properties": {
                    "header_fingerprint": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "delimiter": { "type": "string", "minLength": 1, "maxLength": 1 },
                    "skip_lines": { "type": "integer", "minimum": 0, "maximum": 1000 },
                    "date_order": { "enum": ["mdy", "dmy", "ymd"] },
                    "sign_mode": { "enum": ["signed", "debit_credit", "indicator", "flip"] },
                    "date_col": { "type": "integer", "minimum": 0 },
                    "amount_col": { "type": ["integer", "null"], "minimum": 0 },
                    "debit_col": { "type": ["integer", "null"], "minimum": 0 },
                    "credit_col": { "type": ["integer", "null"], "minimum": 0 },
                    "desc_col": { "type": "integer", "minimum": 0 },
                    "memo_col": { "type": ["integer", "null"], "minimum": 0 },
                    "indicator_col": { "type": ["integer", "null"], "minimum": 0 },
                    "indicator_out_value": { "type": ["string", "null"] }
                  }
                }
              }
            }"#,
            Idempotency::Idempotent,
            LAYOUT,
            remember_layout,
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
                "category_id": { "type": ["string", "null"], "minLength": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            CATEGORIZE,
            categorize,
        ),
        void_line,
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
        CommandDefinition::plain(
            "budget.set",
            "budget",
            r#"{
              "type": "object",
              "required": ["month", "category_id", "amount_minor"],
              "additionalProperties": false,
              "properties": {
                "month": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}$" },
                "category_id": { "type": "string", "minLength": 1 },
                "amount_minor": { "type": ["integer", "null"], "minimum": 0 },
                "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
                "carry": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            PLAN,
            set_plan,
        ),
        CommandDefinition::plain(
            "budget.set_carry",
            "budget",
            r#"{
              "type": "object",
              "required": ["month", "category_id", "carry"],
              "additionalProperties": false,
              "properties": {
                "month": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}$" },
                "category_id": { "type": "string", "minLength": 1 },
                "carry": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            CARRY,
            set_carry,
        ),
        CommandDefinition::plain(
            "checkpoint.record",
            "checkpoint",
            r#"{
              "type": "object",
              "required": ["account_id", "day", "balance_minor"],
              "additionalProperties": false,
              "properties": {
                "account_id": { "type": "string", "minLength": 1 },
                "day": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                "balance_minor": { "type": "integer" }
              }
            }"#,
            Idempotency::Idempotent,
            CHECKPOINT,
            record_checkpoint,
        ),
        CommandDefinition::plain(
            "category.add",
            "category",
            r#"{
              "type": "object",
              "required": ["title"],
              "additionalProperties": false,
              "properties": {
                "title": { "type": "string", "minLength": 1, "maxLength": 60 },
                "parent_id": { "type": "string", "minLength": 1 }
              }
            }"#,
            Idempotency::Once,
            NEW_CATEGORY,
            add_category,
        ),
        merge,
    ]
}
