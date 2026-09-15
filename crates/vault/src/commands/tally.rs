//! The 23 `tally.*` commands — the expense-splitting write surface, real.
//!
//! Wave 2 registered all 23 with their real names, schemas, idempotency classes
//! and risks behind `not_implemented`, so the registry was complete from the
//! first commit and a command door could know every name the product has. This
//! is the other half: the handlers, the preconditions and the postconditions
//! (#1020, D-1020-T3).
//!
//! ## The doctrine the port keeps
//!
//! - **A friend is a canonical `core.party`** plus a `tally_friend` row; the
//!   owner is the implicit `me` and never a friend.
//! - **A group is an AUDIENCE** (#310): a `social_circle` carrying the name and
//!   the membership, decorated by a `tally_group` that carries the icon, the
//!   colour and — since #996 R22 — the ONE currency its ledger is kept in.
//! - **An expense stores its RESOLVED splits**, re-validated here, so a
//!   projection cannot smuggle an unbalanced or out-of-group split past the
//!   vault. Payers are ground facts (#883, ruling O-payers).
//! - **Balances are never stored.** A settlement is real cash that pays one
//!   down, and when the owner is party to it, the owner's money actually moved:
//!   `settle_up` emits the canonical `core_transaction` and binds it, with
//!   `external_id` `tally:settlement:<id>` so a replay is idempotent.
//! - **Trash is reversible** (#441): `delete_expense` sets `deleted_at` and a
//!   30-day `purge_at`, the splits stay put, and `restore_expense` refuses a
//!   window that has lapsed — a restore past it resurrects what the member was
//!   told had been deleted.
//! - **Every mutation of a composite entity snapshots first**: an expense is
//!   its splits, its payers and its lines, so a row-level capture would restore
//!   the header and lose the money.
//!
//! ## What this port does NOT do, and refuses rather than fakes (D-1020-T3b)
//!
//! Three commands read v0's civil-time plane — `expandRecurrence` over a
//! series' own zone (`packages/core/src/time/`, 1,400 lines with a timezone
//! database behind it):
//!
//! | Command | What it needs | What happens here |
//! |---|---|---|
//! | `save_recurring_expense` | `describeRecurrence` for the `preview` | **real**: the describer is the one part with no zone in it and is ported below |
//! | `materialize_recurring_expense` | the occurrence that a series-local wall clock names | **refused**, with a sentence naming the plane |
//! | `edit_recurring_expense_occurrence` | the same, for `occurrence`/`future` scope; and the stranded-exception count for a `series` override | **`series` scope is real**; the other two scopes are refused |
//!
//! A minimal expander written here would be a SECOND recurrence engine, which
//! is the exact failure #996 R21 (drift ONT-25) exists to prevent — three
//! readers spelled one column three ways and every skip was silently ignored.
//! The refusal is typed and names what is missing, so a shell can say "not in
//! this build yet" rather than materialising a wrong occurrence.
//!
//! ## Two gates, never one (census A0)
//!
//! `confirm` on a definition parks a NON-OWNER invocation regardless of risk;
//! the manifest's `confirmation: "required"` is the owner-facing prompt. Tally
//! has 2 of the first (`nudge`, `remove_group_member`) and 7 of the second, and
//! collapsing them loses the non-owner park.

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::clock::{format_iso_ms, parse_iso_ms};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// ~30-day trash grace window before the sweep purges — mirrors Docs/Locker.
const PURGE_WINDOW_DAYS: i64 = 30;

/// The undo window a revision carries (`entity-revisions.ts:9`).
const UNDO_WINDOW_MS: i64 = 10_000;

/// The fixed-point scale every rate is quoted at unless one is supplied.
const RATE_SCALE: i64 = 6;

/// The categories an expense may carry (`tally.ts:265-275`).
const CATEGORY_ENUM: &[&str] = &[
    "food",
    "groceries",
    "rent",
    "utilities",
    "transport",
    "fun",
    "travel",
    "shopping",
    "general",
];

/// The default group colour, when a caller names none.
const DEFAULT_GROUP_COLOR: &str = "#0FA678";

// ---------------------------------------------------------------------------
// Small helpers over the file. SQL lives in `crates/vault` by construction.
// ---------------------------------------------------------------------------

fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

/// An instant `days` later, in the same shape the column holds.
fn plus_days(iso: &str, days: i64) -> Result<String> {
    let millis = parse_iso_ms(iso).ok_or_else(|| VaultError::Invariant {
        context: format!("`{iso}` is not an instant this vault writes"),
    })?;
    Ok(format_iso_ms(millis + days * 86_400_000))
}

fn plus_millis(iso: &str, millis_to_add: i64) -> Result<String> {
    let millis = parse_iso_ms(iso).ok_or_else(|| VaultError::Invariant {
        context: format!("`{iso}` is not an instant this vault writes"),
    })?;
    Ok(format_iso_ms(millis + millis_to_add))
}

/// The day part of an instant — v0's `ctx.now.slice(0, 10)`.
fn day_of(iso: &str) -> String {
    iso.chars().take(10).collect()
}

/// The vault's owner. A vault with none cannot write a Tally row at all: the
/// owner is the implicit `me` every split is about.
fn owner_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let owner: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    owner.ok_or_else(|| VaultError::Invariant {
        context: "this vault has no owner yet; enrol one before using Tally".to_owned(),
    })
}

/// The vault's base currency — what a member who never thinks about currency
/// means.
fn base_currency(connection: &Connection) -> String {
    connection
        .query_row("SELECT base_currency FROM core_vault LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap_or_else(|_| "USD".to_owned())
}

/// The circle a group decorates.
fn circle_of(ctx: &CommandCtx<'_, '_>, group_id: &str) -> Result<String> {
    ctx.connection()
        .query_row(
            "SELECT circle_id FROM tally_group WHERE group_id = ?1",
            [group_id],
            |row| row.get(0),
        )
        .map_err(|_| invalid("group_id", "there is no group with that id"))
}

/// The currency a group's ledger is kept in, or `None` for a group-less row.
fn group_currency(connection: &Connection, group_id: Option<&str>) -> Option<String> {
    let group_id = group_id?;
    connection
        .query_row(
            "SELECT currency FROM tally_group WHERE group_id = ?1",
            [group_id],
            |row| row.get(0),
        )
        .ok()
}

/// Idempotent. Membership is a WRITE: provenance-stamped like any row.
fn add_circle_member(ctx: &CommandCtx<'_, '_>, circle_id: &str, party_id: &str) -> Result<()> {
    let present: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM social_circle_member WHERE circle_id = ?1 AND party_id = ?2",
        rusqlite::params![circle_id, party_id],
        |row| row.get(0),
    )?;
    if present > 0 {
        return Ok(());
    }
    let member_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO social_circle_member (member_id, circle_id, party_id, added_at, capability)
         VALUES (?1, ?2, ?3, ?4, 'read+write')",
        rusqlite::params![member_id, circle_id, party_id, ctx.now],
    )?;
    Ok(())
}

/// In a group, the group's circle (#310); group-less, the friend roster — so a
/// 1:1 expense cannot mint a participant nobody added.
fn participant_scope(ctx: &CommandCtx<'_, '_>, group_id: Option<&str>) -> Result<BTreeSet<String>> {
    let connection = ctx.connection();
    if let Some(group_id) = group_id {
        let mut statement = connection.prepare(
            "SELECT m.party_id FROM social_circle_member m
               JOIN tally_group g ON g.circle_id = m.circle_id
              WHERE g.group_id = ?1",
        )?;
        let rows = statement.query_map([group_id], |row| row.get::<_, String>(0))?;
        return rows
            .collect::<rusqlite::Result<BTreeSet<String>>>()
            .map_err(Into::into);
    }
    let mut scope: BTreeSet<String> = BTreeSet::new();
    scope.insert(owner_party_id(ctx)?);
    let mut statement = connection.prepare("SELECT party_id FROM tally_friend")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    for party_id in rows {
        scope.insert(party_id?);
    }
    Ok(scope)
}

/// `(party_id, amount)` entries out of an input array, with the two errors the
/// shapes can have named.
fn entries(input: &serde_json::Value, key: &str, amount_key: &str) -> Result<Vec<(String, i64)>> {
    let Some(list) = input.get(key).and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(list.len());
    for entry in list {
        let party_id = entry
            .get("party_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| invalid(key, "every entry names a `party_id`"))?;
        let amount = entry
            .get(amount_key)
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| invalid(key, format!("every entry carries `{amount_key}`")))?;
        out.push((party_id.to_owned(), amount));
    }
    Ok(out)
}

/// Nobody outside the roster, and nobody twice.
///
/// The sentence names the SCOPE rather than the person: "not a member of this
/// group" is what a member can act on, and it is the same refusal whether the
/// party exists or not.
fn assert_roster(
    rows: &[(String, i64)],
    allowed: &BTreeSet<String>,
    group_id: Option<&str>,
    what: &str,
) -> Result<()> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for (party_id, _) in rows {
        if !allowed.contains(party_id) {
            return Err(invalid(
                what,
                if group_id.is_some() {
                    format!("a {what} is not a member of this group")
                } else {
                    format!("a {what} on a group-less expense must be you or a Tally friend")
                },
            ));
        }
        if !seen.insert(party_id.as_str()) {
            return Err(invalid(what, format!("duplicate {what}")));
        }
    }
    Ok(())
}

/// The payer set and the principal payer.
///
/// `paid_by` must be one of them. With no payer rows the named payer stands for
/// the whole amount, which is the single-payer expense; with rows, the totals
/// have to agree or the expense does not reconcile.
fn resolve_payers(
    paid_by: Option<&str>,
    amount_minor: i64,
    payers: Vec<(String, i64)>,
) -> Result<(Vec<(String, i64)>, String)> {
    let resolved = if payers.is_empty() {
        match paid_by {
            Some(party_id) => vec![(party_id.to_owned(), amount_minor)],
            None => Vec::new(),
        }
    } else {
        payers
    };
    if resolved.is_empty() {
        return Err(invalid("payers", "an expense needs at least one payer"));
    }
    let total: i64 = resolved.iter().map(|(_, paid)| *paid).sum();
    if total != amount_minor {
        return Err(invalid(
            "payers",
            format!("payers must sum to the amount (got {total}, need {amount_minor})"),
        ));
    }
    if let Some(named) = paid_by
        && !resolved.iter().any(|(party_id, _)| party_id == named)
    {
        return Err(invalid(
            "paid_by",
            "the named payer is not in the payer list",
        ));
    }
    // With no named payer the largest contributor stands in; ties keep the
    // first supplied, so a re-send is stable.
    let principal = paid_by.map(str::to_owned).unwrap_or_else(|| {
        let mut largest = &resolved[0];
        for payer in &resolved {
            if payer.1 > largest.1 {
                largest = payer;
            }
        }
        largest.0.clone()
    });
    Ok((resolved, principal))
}

fn write_payers(
    ctx: &CommandCtx<'_, '_>,
    expense_id: &str,
    group_id: Option<&str>,
    payers: &[(String, i64)],
    allowed: &BTreeSet<String>,
) -> Result<()> {
    assert_roster(payers, allowed, group_id, "payer")?;
    ctx.connection().execute(
        "DELETE FROM tally_expense_payer WHERE expense_id = ?1",
        [expense_id],
    )?;
    for (party_id, paid) in payers {
        ctx.connection().execute(
            "INSERT INTO tally_expense_payer (expense_id, party_id, paid_minor)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![expense_id, party_id, paid],
        )?;
    }
    Ok(())
}

fn write_splits(
    ctx: &CommandCtx<'_, '_>,
    expense_id: &str,
    group_id: Option<&str>,
    amount_minor: i64,
    splits: &[(String, i64)],
    allowed: &BTreeSet<String>,
) -> Result<()> {
    if splits.is_empty() {
        return Err(invalid(
            "splits",
            "an expense needs at least one participant",
        ));
    }
    assert_roster(splits, allowed, group_id, "split participant")?;
    let sum: i64 = splits.iter().map(|(_, share)| *share).sum();
    if sum != amount_minor {
        return Err(invalid(
            "splits",
            format!("splits must sum to the amount (got {sum}, need {amount_minor})"),
        ));
    }
    ctx.connection().execute(
        "DELETE FROM tally_expense_split WHERE expense_id = ?1",
        [expense_id],
    )?;
    for (party_id, share) in splits {
        ctx.connection().execute(
            "INSERT INTO tally_expense_split (expense_id, party_id, share_minor)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![expense_id, party_id, share],
        )?;
    }
    Ok(())
}

/// One typed line, as an input carries it.
struct LineInput {
    kind: String,
    description: String,
    amount_minor: i64,
    allocations: Vec<(String, i64)>,
}

fn line_inputs(input: &serde_json::Value) -> Result<Option<Vec<LineInput>>> {
    let Some(list) = input.get("line_items") else {
        return Ok(None);
    };
    let list = list
        .as_array()
        .ok_or_else(|| invalid("line_items", "the lines are a list"))?;
    let mut out = Vec::with_capacity(list.len());
    for line in list {
        out.push(LineInput {
            kind: line
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("item")
                .to_owned(),
            description: line
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            amount_minor: line
                .get("amount_minor")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| invalid("line_items", "every line carries `amount_minor`"))?,
            allocations: entries(line, "allocations", "share_minor")?,
        });
    }
    Ok(Some(out))
}

/// Replaces the whole line set. BOTH totals are re-checked — lines sum to the
/// expense, allocations sum to their line — or the reconciliation is a lie.
fn write_line_items(
    ctx: &CommandCtx<'_, '_>,
    expense_id: &str,
    receipt_id: Option<&str>,
    group_id: Option<&str>,
    amount_minor: i64,
    lines: &[LineInput],
    allowed: &BTreeSet<String>,
) -> Result<()> {
    let line_total: i64 = lines.iter().map(|line| line.amount_minor).sum();
    if line_total != amount_minor {
        return Err(invalid(
            "line_items",
            format!("lines must sum to the expense amount (got {line_total}, need {amount_minor})"),
        ));
    }
    for line in lines {
        let allocated: i64 = line.allocations.iter().map(|(_, share)| *share).sum();
        if allocated != line.amount_minor {
            return Err(invalid(
                "line_items",
                format!(
                    "allocations for \"{}\" must sum to its amount",
                    line.description
                ),
            ));
        }
        assert_roster(&line.allocations, allowed, group_id, "line allocation")?;
    }
    // Allocations cascade with their line, so deleting the lines clears both.
    ctx.connection().execute(
        "DELETE FROM tally_expense_line_item WHERE expense_id = ?1",
        [expense_id],
    )?;
    for (index, line) in lines.iter().enumerate() {
        let line_item_id = ctx.next_id();
        ctx.connection().execute(
            "INSERT INTO tally_expense_line_item
               (line_item_id, expense_id, receipt_id, kind, description, amount_minor,
                sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                line_item_id,
                expense_id,
                receipt_id,
                line.kind,
                line.description,
                line.amount_minor,
                i64::try_from(index).unwrap_or(i64::MAX),
                ctx.now
            ],
        )?;
        for (party_id, share) in &line.allocations {
            ctx.connection().execute(
                "INSERT INTO tally_expense_line_allocation
                   (line_item_id, party_id, share_minor, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![line_item_id, party_id, share, ctx.now],
            )?;
        }
    }
    Ok(())
}

/// `originalMinor * rateScaled / 10^rateScale`, rounded half up, in integers.
///
/// The whole point of the fixed-point pair is that the settlement amount
/// REPRODUCES from it exactly, so this is the one place the arithmetic lives and
/// it is done in `i128` — a rate at scale 12 over a large amount overflows an
/// `i64` before the divide.
fn convert_currency_minor(original_minor: i64, rate_scaled: i64, rate_scale: i64) -> Result<i64> {
    if original_minor <= 0 || rate_scaled <= 0 || !(0..=12).contains(&rate_scale) {
        return Err(invalid(
            "rate_scaled",
            "invalid fixed-point currency conversion",
        ));
    }
    let divisor = 10_i128.pow(u32::try_from(rate_scale).unwrap_or(0));
    let rounded = (i128::from(original_minor) * i128::from(rate_scaled) + divisor / 2) / divisor;
    i64::try_from(rounded)
        .ok()
        .filter(|amount| *amount > 0)
        .ok_or_else(|| {
            invalid(
                "amount_minor",
                "converted amount is outside the supported range",
            )
        })
}

/// What an expense's row already says about its money: the group it is in, and
/// the seven FX columns an edit either preserves or retargets. A tuple rather
/// than a struct because it is read once, positionally, straight off the row.
type HeldFx = (
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
);

/// The fixed-point FX provenance every new expense carries (#630).
struct ResolvedFx {
    original_amount: i64,
    original_currency: String,
    settlement_currency: String,
    rate_scaled: i64,
    rate_scale: i64,
    rate_source: String,
    rate_date: String,
}

/// There is no rate provider and the vault works with none: a cross-currency
/// expense arrives WITH its rate, source and effective date, and the settlement
/// amount must reproduce from them exactly.
fn resolve_new_expense_fx(
    ctx: &CommandCtx<'_, '_>,
    amount_minor: i64,
    group_id: Option<&str>,
) -> Result<ResolvedFx> {
    let connection = ctx.connection();
    // A GROUPED expense is in its group's currency (#916, R1); the vault's base
    // is the answer only for a group-less 1:1, where there is no shared ledger
    // to agree with.
    let base = group_currency(connection, group_id).unwrap_or_else(|| base_currency(connection));
    let original_currency = ctx
        .optional_str("original_currency")
        .unwrap_or(&base)
        .to_uppercase();
    let settlement_currency = ctx
        .optional_str("settlement_currency")
        .unwrap_or(&base)
        .to_uppercase();
    let original_amount = ctx
        .input
        .get("original_amount_minor")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(amount_minor);
    let rate_scale = ctx
        .input
        .get("rate_scale")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(RATE_SCALE);
    let same = original_currency == settlement_currency;
    let rate_scaled = ctx
        .input
        .get("rate_scaled")
        .and_then(serde_json::Value::as_i64)
        .or_else(|| same.then(|| 10_i64.pow(u32::try_from(rate_scale).unwrap_or(0))));
    let source = ctx.optional_str("rate_source");
    let date = ctx.optional_str("rate_date");
    let Some(rate_scaled) = rate_scaled else {
        return Err(invalid(
            "rate_scaled",
            "cross-currency expenses need a rate, source, and effective date",
        ));
    };
    if !same && (source.is_none() || date.is_none()) {
        return Err(invalid(
            "rate_source",
            "cross-currency expenses need a rate, source, and effective date",
        ));
    }
    if convert_currency_minor(original_amount, rate_scaled, rate_scale)? != amount_minor {
        return Err(invalid(
            "amount_minor",
            "settlement amount does not match the supplied rate",
        ));
    }
    Ok(ResolvedFx {
        original_amount,
        original_currency,
        settlement_currency,
        rate_scaled,
        rate_scale,
        rate_source: source.unwrap_or("identity").to_owned(),
        rate_date: date
            .map(str::to_owned)
            .or_else(|| ctx.optional_str("spent_on").map(str::to_owned))
            .unwrap_or_else(|| day_of(&ctx.now)),
    })
}

/// Absent method, typed lines present, reads as the "By line" division.
fn split_method_of(method: Option<&str>, lines: Option<&Vec<LineInput>>) -> String {
    method.map(str::to_owned).unwrap_or_else(|| {
        if lines.is_some_and(|lines| !lines.is_empty()) {
            "by_line".to_owned()
        } else {
            "exact".to_owned()
        }
    })
}

/// Insert one expense row with its FX and split provenance.
fn insert_expense_row(
    ctx: &CommandCtx<'_, '_>,
    expense_id: &str,
    group_id: Option<&str>,
    amount_minor: i64,
    paid_by: &str,
    split_method: &str,
    fx: &ResolvedFx,
) -> Result<()> {
    let split_params_json = ctx
        .input
        .get("split_params")
        .map(|params| serde_json::to_string(params).unwrap_or_else(|_| "{}".to_owned()));
    ctx.connection().execute(
        "INSERT INTO tally_expense
           (expense_id, group_id, description, amount_minor, currency, paid_by, spent_on,
            category, split_method, split_params_json, created_at,
            original_amount_minor, original_currency,
            settlement_currency, rate_scaled, rate_scale, rate_source, rate_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        rusqlite::params![
            expense_id,
            group_id,
            ctx.required_str("description")?,
            amount_minor,
            // `amount_minor` IS the settlement currency (#916, R1): shares of
            // it inherit that by construction, so no split or payer carries a
            // currency column.
            fx.settlement_currency,
            paid_by,
            ctx.optional_str("spent_on")
                .map_or_else(|| day_of(&ctx.now), str::to_owned),
            ctx.required_str("category")?,
            split_method,
            split_params_json,
            ctx.now,
            fx.original_amount,
            fx.original_currency,
            fx.settlement_currency,
            fx.rate_scaled,
            fx.rate_scale,
            fx.rate_source,
            fx.rate_date,
        ],
    )?;
    Ok(())
}

/// A category the vault does not know is refused rather than stored.
fn assert_category(ctx: &CommandCtx<'_, '_>) -> Result<()> {
    let category = ctx.required_str("category")?;
    if CATEGORY_ENUM.contains(&category) {
        return Ok(());
    }
    Err(invalid(
        "category",
        format!("`{category}` is not one of Tally's categories"),
    ))
}

// ---------------------------------------------------------------------------
// Revisions: the pre-image an undo needs.
// ---------------------------------------------------------------------------

/// The composite snapshot of one expense: the row, its splits, its payers and
/// — when the operation rewrites them — its typed lines.
///
/// A ROW-LEVEL capture would restore the header and lose the money, which is
/// why this handful of entities snapshot themselves (`entity-revisions.ts:33`).
fn expense_snapshot(
    ctx: &CommandCtx<'_, '_>,
    expense_id: &str,
    with_lines: bool,
) -> Result<serde_json::Value> {
    let connection = ctx.connection();
    let expense = connection
        .query_row(
            "SELECT description, amount_minor, paid_by, split_method, split_params_json,
                    spent_on, category, original_amount_minor, original_currency,
                    settlement_currency, rate_scaled, rate_scale, rate_source, rate_date,
                    deleted_at, purge_at
               FROM tally_expense WHERE expense_id = ?1",
            [expense_id],
            |row| {
                Ok(serde_json::json!({
                    "description": row.get::<_, String>(0)?,
                    "amount_minor": row.get::<_, i64>(1)?,
                    "paid_by": row.get::<_, String>(2)?,
                    "split_method": row.get::<_, Option<String>>(3)?,
                    "split_params_json": row.get::<_, Option<String>>(4)?,
                    "spent_on": row.get::<_, String>(5)?,
                    "category": row.get::<_, String>(6)?,
                    "original_amount_minor": row.get::<_, Option<i64>>(7)?,
                    "original_currency": row.get::<_, Option<String>>(8)?,
                    "settlement_currency": row.get::<_, Option<String>>(9)?,
                    "rate_scaled": row.get::<_, Option<i64>>(10)?,
                    "rate_scale": row.get::<_, Option<i64>>(11)?,
                    "rate_source": row.get::<_, Option<String>>(12)?,
                    "rate_date": row.get::<_, Option<String>>(13)?,
                    "deleted_at": row.get::<_, Option<String>>(14)?,
                    "purge_at": row.get::<_, Option<String>>(15)?,
                }))
            },
        )
        .map_err(|_| invalid("expense_id", "there is no expense with that id"))?;
    let pairs = |sql: &str, amount_key: &'static str| -> Result<serde_json::Value> {
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map([expense_id], |row| {
            Ok(serde_json::json!({
                "party_id": row.get::<_, String>(0)?,
                amount_key: row.get::<_, i64>(1)?,
            }))
        })?;
        Ok(serde_json::Value::Array(
            rows.collect::<rusqlite::Result<Vec<_>>>()?,
        ))
    };
    let mut snapshot = serde_json::json!({
        "expense": expense,
        "splits": pairs(
            "SELECT party_id, share_minor FROM tally_expense_split
              WHERE expense_id = ?1 ORDER BY party_id",
            "share_minor",
        )?,
        "payers": pairs(
            "SELECT party_id, paid_minor FROM tally_expense_payer
              WHERE expense_id = ?1 ORDER BY party_id",
            "paid_minor",
        )?,
    });
    if with_lines {
        snapshot["lines"] = expense_line_snapshot(ctx, expense_id)?;
    }
    Ok(snapshot)
}

fn expense_line_snapshot(ctx: &CommandCtx<'_, '_>, expense_id: &str) -> Result<serde_json::Value> {
    let connection = ctx.connection();
    let mut statement = connection.prepare(
        "SELECT line_item_id, receipt_id, kind, description, amount_minor, sort_order
           FROM tally_expense_line_item WHERE expense_id = ?1 ORDER BY sort_order",
    )?;
    let lines: Vec<(String, Option<String>, String, String, i64, i64)> = statement
        .query_map([expense_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(lines.len());
    for (line_item_id, receipt_id, kind, description, amount_minor, sort_order) in lines {
        let mut allocations = connection.prepare(
            "SELECT party_id, share_minor FROM tally_expense_line_allocation
              WHERE line_item_id = ?1 ORDER BY party_id",
        )?;
        let rows = allocations.query_map([&line_item_id], |row| {
            Ok(serde_json::json!({
                "party_id": row.get::<_, String>(0)?,
                "share_minor": row.get::<_, i64>(1)?,
            }))
        })?;
        out.push(serde_json::json!({
            "line_item_id": line_item_id,
            "receipt_id": receipt_id,
            "kind": kind,
            "description": description,
            "amount_minor": amount_minor,
            "sort_order": sort_order,
            "allocations": serde_json::Value::Array(rows.collect::<rusqlite::Result<Vec<_>>>()?),
        }));
    }
    Ok(serde_json::Value::Array(out))
}

/// Append a pre-mutation snapshot; returns `(revision_id, undo_until)`.
fn record_expense_revision(
    ctx: &CommandCtx<'_, '_>,
    expense_id: &str,
    operation: &str,
    with_lines: bool,
) -> Result<(String, String)> {
    let snapshot = expense_snapshot(ctx, expense_id, with_lines)?;
    let revision_id = ctx.next_id();
    let undo_until = plus_millis(&ctx.now, UNDO_WINDOW_MS)?;
    let actor = owner_party_id(ctx).ok();
    ctx.connection().execute(
        "INSERT INTO core_entity_revision
           (revision_id, entity_type, entity_id, operation, snapshot_json,
            recorded_at, undo_until, undone_at, actor_party_id, invocation_id)
         VALUES (?1, 'tally.expense', ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)",
        rusqlite::params![
            revision_id,
            expense_id,
            operation,
            serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".to_owned()),
            ctx.now,
            undo_until,
            actor,
            ctx.invocation_id,
        ],
    )?;
    Ok((revision_id, undo_until))
}

/// Put back exactly what a revision holds — including the payer set a snapshot
/// recorded before multi-payer expenses existed, which is restated from the
/// restored `paid_by` so the fold never sees an expense nobody paid for.
fn restore_expense_snapshot(
    ctx: &CommandCtx<'_, '_>,
    expense_id: &str,
    snapshot: &serde_json::Value,
) -> Result<()> {
    let expense = &snapshot["expense"];
    let text = |key: &str| expense.get(key).and_then(serde_json::Value::as_str);
    let number = |key: &str| expense.get(key).and_then(serde_json::Value::as_i64);
    ctx.connection().execute(
        "UPDATE tally_expense
            SET description = ?1, amount_minor = ?2, paid_by = ?3,
                split_method = COALESCE(?4, split_method),
                split_params_json = ?5, spent_on = ?6, category = ?7,
                original_amount_minor = ?8, original_currency = ?9,
                settlement_currency = ?10, rate_scaled = ?11, rate_scale = ?12,
                rate_source = ?13, rate_date = ?14, deleted_at = ?15, purge_at = ?16
          WHERE expense_id = ?17",
        rusqlite::params![
            text("description"),
            number("amount_minor"),
            text("paid_by"),
            text("split_method"),
            text("split_params_json"),
            text("spent_on"),
            text("category"),
            number("original_amount_minor"),
            text("original_currency"),
            text("settlement_currency"),
            number("rate_scaled"),
            number("rate_scale"),
            text("rate_source"),
            text("rate_date"),
            text("deleted_at"),
            text("purge_at"),
            expense_id,
        ],
    )?;
    ctx.connection().execute(
        "DELETE FROM tally_expense_split WHERE expense_id = ?1",
        [expense_id],
    )?;
    for split in snapshot["splits"].as_array().into_iter().flatten() {
        ctx.connection().execute(
            "INSERT INTO tally_expense_split (expense_id, party_id, share_minor)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![
                expense_id,
                split.get("party_id").and_then(serde_json::Value::as_str),
                split.get("share_minor").and_then(serde_json::Value::as_i64),
            ],
        )?;
    }
    ctx.connection().execute(
        "DELETE FROM tally_expense_payer WHERE expense_id = ?1",
        [expense_id],
    )?;
    let payers: Vec<(String, i64)> = snapshot["payers"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|payer| {
                    Some((
                        payer.get("party_id")?.as_str()?.to_owned(),
                        payer.get("paid_minor")?.as_i64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let payers = if payers.is_empty() {
        vec![(
            text("paid_by").unwrap_or_default().to_owned(),
            number("amount_minor").unwrap_or_default(),
        )]
    } else {
        payers
    };
    for (party_id, paid) in payers {
        ctx.connection().execute(
            "INSERT INTO tally_expense_payer (expense_id, party_id, paid_minor)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![expense_id, party_id, paid],
        )?;
    }
    if let Some(lines) = snapshot.get("lines").and_then(serde_json::Value::as_array) {
        ctx.connection().execute(
            "DELETE FROM tally_expense_line_item WHERE expense_id = ?1",
            [expense_id],
        )?;
        for line in lines {
            let line_item_id = line
                .get("line_item_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            ctx.connection().execute(
                "INSERT INTO tally_expense_line_item
                   (line_item_id, expense_id, receipt_id, kind, description, amount_minor,
                    sort_order, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    line_item_id,
                    expense_id,
                    line.get("receipt_id").and_then(serde_json::Value::as_str),
                    line.get("kind").and_then(serde_json::Value::as_str),
                    line.get("description").and_then(serde_json::Value::as_str),
                    line.get("amount_minor").and_then(serde_json::Value::as_i64),
                    line.get("sort_order").and_then(serde_json::Value::as_i64),
                    ctx.now,
                ],
            )?;
            for allocation in line["allocations"].as_array().into_iter().flatten() {
                ctx.connection().execute(
                    "INSERT INTO tally_expense_line_allocation
                       (line_item_id, party_id, share_minor, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        line_item_id,
                        allocation
                            .get("party_id")
                            .and_then(serde_json::Value::as_str),
                        allocation
                            .get("share_minor")
                            .and_then(serde_json::Value::as_i64),
                        ctx.now,
                    ],
                )?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The conditions, as the predicates they are named by.
// ---------------------------------------------------------------------------

fn count(ctx: &CommandCtx<'_, '_>, sql: &str, bind: &[&dyn rusqlite::ToSql]) -> Result<i64> {
    Ok(ctx.connection().query_row(sql, bind, |row| row.get(0))?)
}

/// A group exists IF one was named. An omitted optional input is not a missing
/// group: a group-less 1:1 expense passes with no group to check, rather than
/// by dropping the condition.
fn group_exists_if_named() -> CommandCondition {
    CommandCondition {
        predicate: "group_exists_if_named",
        check: |ctx| {
            let Some(group_id) = ctx.optional_str("group_id") else {
                return Ok(None);
            };
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_group WHERE group_id = ?1",
                &[&group_id],
            )?;
            Ok((found != 1).then(|| "there is no group with that id".to_owned()))
        },
    }
}

/// A live expense is one not in the trash — the guard for edit, memo and trash,
/// so a row already on its way out cannot be mutated or re-trashed (#441).
fn expense_live() -> CommandCondition {
    CommandCondition {
        predicate: "expense_live",
        check: |ctx| {
            let expense_id = ctx.required_str("expense_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_expense
                  WHERE expense_id = ?1 AND deleted_at IS NULL",
                &[&expense_id],
            )?;
            Ok((found != 1).then(|| "there is no expense with that id in your ledger".to_owned()))
        },
    }
}

/// RESTORE REFUSES A LAPSED WINDOW (#916, review 1.5): the trash window is a
/// promise that the row goes, and a restore past it resurrects what the member
/// was told had been deleted.
///
/// **Read against `:ctx_now`, not SQLite's `now`** (lane V's one-clock fix).
/// v0's SQL compared `purge_at` with `strftime(… ,'now')`, which no injected
/// clock reaches — so a fixture at a frozen instant could not exercise the
/// trash at all, and a seat with a skewed clock got a different answer from its
/// own handler.
fn expense_trashed() -> CommandCondition {
    CommandCondition {
        predicate: "expense_trashed",
        check: |ctx| {
            let expense_id = ctx.required_str("expense_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_expense
                  WHERE expense_id = ?1 AND deleted_at IS NOT NULL
                    AND (purge_at IS NULL OR purge_at > ?2)",
                &[&expense_id, &ctx.now],
            )?;
            Ok((found != 1)
                .then(|| "that expense is not in the trash, or its window has lapsed".to_owned()))
        },
    }
}

/// A member's net position in one group, per currency.
///
/// "OFF LEDGER" MEANS SETTLED UP, NOT ABSENT FROM HISTORY (#1020, R-1020-35;
/// lane D3's finding 8, option (b)). The predicate used to count the expenses a
/// member had been named in and refuse if there were any — which is every
/// member a group has ever had, so `remove_group_member` was unreachable for
/// anybody who had spent anything. The question is the BALANCE: what they put
/// down, less what they were split, plus what they have paid out, less what
/// they have been paid. Zero in every currency is off ledger.
fn member_off_ledger() -> CommandCondition {
    CommandCondition {
        predicate: "member_off_ledger",
        check: |ctx| {
            let group_id = ctx.required_str("group_id")?;
            let party_id = ctx.required_str("party_id")?;
            let unsettled: i64 = ctx.connection().query_row(
                "WITH ledger AS (
                   SELECT e.currency AS currency,
                          CASE
                            WHEN EXISTS (SELECT 1 FROM tally_expense_payer p
                                          WHERE p.expense_id = e.expense_id)
                              THEN COALESCE((SELECT SUM(p.paid_minor) FROM tally_expense_payer p
                                              WHERE p.expense_id = e.expense_id
                                                AND p.party_id = ?2), 0)
                            WHEN e.paid_by = ?2 THEN e.amount_minor
                            ELSE 0
                          END
                          - COALESCE((SELECT SUM(s.share_minor) FROM tally_expense_split s
                                       WHERE s.expense_id = e.expense_id
                                         AND s.party_id = ?2), 0) AS net_minor
                     FROM tally_expense e
                    WHERE e.group_id = ?1 AND e.deleted_at IS NULL
                   UNION ALL
                   SELECT t.currency AS currency,
                          CASE WHEN t.from_party = ?2 THEN t.amount_minor ELSE 0 END
                          - CASE WHEN t.to_party = ?2 THEN t.amount_minor ELSE 0 END AS net_minor
                     FROM tally_settlement t
                    WHERE t.group_id = ?1 AND t.deleted_at IS NULL
                      AND (t.from_party = ?2 OR t.to_party = ?2)
                 )
                 SELECT COUNT(*) FROM (
                   SELECT currency FROM ledger GROUP BY currency
                    HAVING SUM(net_minor) <> 0
                 )",
                rusqlite::params![group_id, party_id],
                |row| row.get(0),
            )?;
            Ok((unsettled != 0).then(|| {
                "this member still has an unsettled balance in this group; settle up first, or the group keeps their history"
                    .to_owned()
            }))
        },
    }
}

/// A minted id a caller supplied must be FREE. A caller that picks its own id
/// is claiming the row does not exist yet; silently updating one would make a
/// retry of a different intent overwrite a live row.
const fn minted_id_is_free(
    predicate: &'static str,
    check: fn(&CommandCtx<'_, '_>) -> Result<Option<String>>,
) -> CommandCondition {
    CommandCondition { predicate, check }
}

/// The id a caller supplied, else a fresh one.
fn minted_id(ctx: &CommandCtx<'_, '_>, key: &str) -> String {
    ctx.optional_str(key)
        .map_or_else(|| ctx.next_id(), str::to_owned)
}

// ---------------------------------------------------------------------------
// The definitions.
// ---------------------------------------------------------------------------

/// Every `tally.*` command in the catalogue, with its real body.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_friend(),
        create_group(),
        rename_group(),
        add_group_member(),
        remove_group_member(),
        delete_group(),
        leave_group(),
        archive_group(),
        set_group_simplification(),
        add_expense(),
        add_receipt_expense(),
        edit_expense(),
        delete_expense(),
        restore_expense(),
        undo_expense(),
        reallocate_receipt(),
        settle_up(),
        bind_txn(),
        set_expense_memo(),
        nudge(),
        save_recurring_expense(),
        materialize_recurring_expense(),
        edit_recurring_expense_occurrence(),
    ]
}

fn definition(
    name: &'static str,
    input_schema: &'static str,
    idempotency: Idempotency,
    preconditions: &'static [CommandCondition],
    postconditions: &'static [CommandCondition],
    handler: crate::commands::CommandHandler,
) -> CommandDefinition {
    CommandDefinition {
        name,
        owner_schema: "tally",
        input_schema,
        idempotency,
        risk: Risk::Low,
        confirm: false,
        preconditions,
        postconditions,
        handler,
        sealed_input: &[],
        online_only: false,
    }
}

fn add_friend() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "named_party_exists",
        check: |ctx| {
            let Some(party_id) = ctx.optional_str("party_id") else {
                return Ok(None);
            };
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_party WHERE party_id = ?1 AND kind = 'person'",
                &[&party_id],
            )?;
            Ok((found != 1).then(|| "there is no person with that id".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "friend_created",
        check: |ctx| {
            let name = ctx.required_str("name")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_friend f JOIN core_party p ON p.party_id = f.party_id
                  WHERE p.display_name = ?1 OR f.party_id = ?2",
                &[&name, &ctx.optional_str("party_id").unwrap_or_default()],
            )?;
            Ok((found < 1).then(|| "the friend was not enrolled".to_owned()))
        },
    }];
    definition(
        "tally.add_friend",
        r#"{
          "type": "object",
          "required": ["name"],
          "additionalProperties": false,
          "properties": {
            "name": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 },
            "email": { "type": "string", "minLength": 3 },
            "phone": { "type": "string", "minLength": 3 }
          }
        }"#,
        Idempotency::Once,
        PRE,
        POST,
        |ctx| {
            // THE EXISTING-PARTY BRANCH (#883). Minting unconditionally would
            // give one human two parties, and the avatar hue derives from the
            // party id, so "one hue per party" depends on ENROLLING rather
            // than minting. A NAME IS NEVER A KEY: two people are called Ann.
            //
            // `email`/`phone` resolve through the contact-reach plane in v0,
            // which is the People lane's (`social_contact_channel`, #883
            // ruling O-contact). Rather than drop a reach the caller believes
            // it bound — the failure mode `core.add_party` refuses for the
            // same reason — they are REFUSED here, naming the command that
            // takes them.
            for key in ["email", "phone"] {
                if ctx.optional_str(key).is_some() {
                    return Err(invalid(
                        key,
                        "an address is a way to reach someone, not an identity; \
                         add the person, then bind it with `social.save_contact_channel`",
                    ));
                }
            }
            let name = ctx.required_str("name")?.to_owned();
            let found = ctx.optional_str("party_id").map(str::to_owned);
            let party_id = found.clone().unwrap_or_else(|| ctx.next_id());
            if found.is_none() {
                ctx.connection().execute(
                    "INSERT INTO core_party
                       (party_id, kind, display_name, sort_name, birth_date,
                        avatar_content_id, created_at, updated_at)
                     VALUES (?1, 'person', ?2, NULL, NULL, NULL, ?3, ?3)",
                    rusqlite::params![party_id, name, ctx.now],
                )?;
            }
            // Already a friend: the enrollment stands and nothing is written
            // twice.
            let enrolled: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT friend_id FROM tally_friend WHERE party_id = ?1",
                    [&party_id],
                    |row| row.get(0),
                )
                .ok();
            if enrolled.is_none() {
                let friend_id = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO tally_friend (friend_id, party_id, created_at)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![friend_id, party_id, ctx.now],
                )?;
            }
            Ok(serde_json::json!({
                "party_id": party_id,
                "reused_party": found.is_some(),
            }))
        },
    )
}

fn create_group() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[minted_id_is_free("group_id_free", |ctx| {
        let Some(group_id) = ctx.optional_str("group_id") else {
            return Ok(None);
        };
        let found = count(
            ctx,
            "SELECT COUNT(*) FROM tally_group WHERE group_id = ?1",
            &[&group_id],
        )?;
        Ok((found != 0).then(|| "a group with that id already exists".to_owned()))
    })];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "group_created",
        check: |ctx| {
            let circle_name = ctx.required_str("name")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_group g JOIN social_circle c ON c.circle_id = g.circle_id
                  WHERE c.name = ?1",
                &[&circle_name],
            )?;
            Ok((found < 1).then(|| "the group was not created".to_owned()))
        },
    }];
    definition(
        "tally.create_group",
        r#"{
          "type": "object",
          "required": ["name", "icon", "member_ids"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 },
            "icon": { "type": "string", "minLength": 1 },
            "color": { "type": "string" },
            "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
            "member_ids": { "type": "array", "items": { "type": "string", "minLength": 1 } }
          }
        }"#,
        Idempotency::Once,
        PRE,
        POST,
        |ctx| {
            let name = ctx.required_str("name")?.to_owned();
            let owner = owner_party_id(ctx)?;
            // Circles are UNIQUE(owner, name), so a clash is a real clash and
            // is named rather than turned into a second circle.
            let clash = count(
                ctx,
                "SELECT COUNT(*) FROM social_circle WHERE owner_party_id = ?1 AND name = ?2",
                &[&owner, &name],
            )?;
            if clash > 0 {
                return Err(invalid(
                    "name",
                    format!("a circle named \"{name}\" already exists"),
                ));
            }
            let circle_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
                 VALUES (?1, ?2, ?3, 'custom')",
                rusqlite::params![circle_id, owner, name],
            )?;
            let group_id = minted_id(ctx, "group_id");
            let currency = ctx
                .optional_str("currency")
                .map_or_else(|| base_currency(ctx.connection()), str::to_owned)
                .to_uppercase();
            ctx.connection().execute(
                "INSERT INTO tally_group
                   (group_id, circle_id, icon, color, currency, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    group_id,
                    circle_id,
                    ctx.required_str("icon")?,
                    ctx.optional_str("color").unwrap_or(DEFAULT_GROUP_COLOR),
                    currency,
                    ctx.now
                ],
            )?;
            // The owner is always a member; friends are added by party id.
            let mut members: BTreeSet<String> = BTreeSet::new();
            members.insert(owner);
            for member in ctx
                .input
                .get("member_ids")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
            {
                members.insert(member.to_owned());
            }
            for party_id in &members {
                add_circle_member(ctx, &circle_id, party_id)?;
            }
            Ok(serde_json::json!({ "group_id": group_id }))
        },
    )
}

fn rename_group() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[];
    static POST: &[CommandCondition] = &[];
    let mut definition = definition(
        "tally.rename_group",
        r#"{
          "type": "object",
          "required": ["group_id", "name"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        POST,
        |ctx| {
            // THE NAME LIVES ON THE CIRCLE. A `tally_group` has no name column:
            // the audience carries it, and a rename that wrote one here would
            // give the group two names.
            let group_id = ctx.required_str("group_id")?.to_owned();
            let circle_id = circle_of(ctx, &group_id)?;
            ctx.connection().execute(
                "UPDATE social_circle SET name = ?1 WHERE circle_id = ?2",
                rusqlite::params![ctx.required_str("name")?, circle_id],
            )?;
            Ok(serde_json::json!({ "group_id": group_id }))
        },
    );
    definition.preconditions = GROUP_EXISTS;
    definition
}

/// One shared `group_exists` precondition list, so the ten commands that need
/// it do not each allocate one.
static GROUP_EXISTS: &[CommandCondition] = &[CommandCondition {
    predicate: "group_exists",
    check: |ctx| {
        let group_id = ctx.required_str("group_id")?;
        let found = count(
            ctx,
            "SELECT COUNT(*) FROM tally_group WHERE group_id = ?1",
            &[&group_id],
        )?;
        Ok((found != 1).then(|| "there is no group with that id".to_owned()))
    },
}];

fn add_group_member() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "member_present",
        check: |ctx| {
            let group_id = ctx.required_str("group_id")?;
            let party_id = ctx.required_str("party_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM social_circle_member m
                   JOIN tally_group g ON g.circle_id = m.circle_id
                  WHERE g.group_id = ?1 AND m.party_id = ?2",
                &[&group_id, &party_id],
            )?;
            Ok((found != 1).then(|| "the member was not added".to_owned()))
        },
    }];
    let mut definition = definition(
        "tally.add_group_member",
        r#"{
          "type": "object",
          "required": ["group_id", "party_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        POST,
        |ctx| {
            let group_id = ctx.required_str("group_id")?.to_owned();
            let party_id = ctx.required_str("party_id")?.to_owned();
            let circle_id = circle_of(ctx, &group_id)?;
            add_circle_member(ctx, &circle_id, &party_id)?;
            Ok(serde_json::json!({ "group_id": group_id }))
        },
    );
    definition.preconditions = GROUP_EXISTS;
    definition
}

fn remove_group_member() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "group_exists",
            check: |ctx| (GROUP_EXISTS[0].check)(ctx),
        },
        CommandCondition {
            predicate: "member_off_ledger",
            check: |ctx| (member_off_ledger().check)(ctx),
        },
    ];
    let mut definition = definition(
        "tally.remove_group_member",
        r#"{
          "type": "object",
          "required": ["group_id", "party_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let group_id = ctx.required_str("group_id")?.to_owned();
            let party_id = ctx.required_str("party_id")?.to_owned();
            if party_id == owner_party_id(ctx)? {
                // LEAVING IS A DIFFERENT ACT. `leave_group` keeps the rows and
                // asks nothing about the balance; removing yourself through
                // this door would be the same write with the wrong name on it.
                return Err(invalid(
                    "party_id",
                    "you cannot remove yourself from a group; leave it instead",
                ));
            }
            let circle_id = circle_of(ctx, &group_id)?;
            ctx.connection().execute(
                "DELETE FROM social_circle_member WHERE circle_id = ?1 AND party_id = ?2",
                rusqlite::params![circle_id, party_id],
            )?;
            Ok(serde_json::json!({ "group_id": group_id }))
        },
    );
    // THE SECOND OF TALLY'S TWO COMMAND-LEVEL CONFIRMS (census A0): a
    // non-owner invocation parks regardless of risk, because removing somebody
    // from a shared ledger is not a write an agent should land unattended.
    definition.confirm = true;
    definition
}

fn delete_group() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "group_exists",
            check: |ctx| (GROUP_EXISTS[0].check)(ctx),
        },
        CommandCondition {
            predicate: "group_empty",
            check: |ctx| {
                let group_id = ctx.required_str("group_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM tally_expense WHERE group_id = ?1",
                    &[&group_id],
                )?;
                Ok((found != 0).then(|| {
                    "this group still has expenses; a group with money in it is not deleted"
                        .to_owned()
                }))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "group_gone",
        check: |ctx| {
            let group_id = ctx.required_str("group_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_group WHERE group_id = ?1",
                &[&group_id],
            )?;
            Ok((found != 0).then(|| "the group is still here".to_owned()))
        },
    }];
    definition(
        "tally.delete_group",
        r#"{
          "type": "object",
          "required": ["group_id"],
          "additionalProperties": false,
          "properties": { "group_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Once,
        PRE,
        POST,
        |ctx| {
            let group_id = ctx.required_str("group_id")?.to_owned();
            let circle_id = circle_of(ctx, &group_id)?;
            ctx.connection().execute(
                "DELETE FROM tally_settlement WHERE group_id = ?1",
                [&group_id],
            )?;
            // Decoration first (it references the circle), then the circle and
            // its membership: the group owned its audience, so it leaves with
            // it.
            ctx.connection()
                .execute("DELETE FROM tally_group WHERE group_id = ?1", [&group_id])?;
            ctx.connection().execute(
                "DELETE FROM social_circle_member WHERE circle_id = ?1",
                [&circle_id],
            )?;
            ctx.connection().execute(
                "DELETE FROM social_circle WHERE circle_id = ?1",
                [&circle_id],
            )?;
            Ok(serde_json::json!({ "group_id": group_id }))
        },
    )
}

fn leave_group() -> CommandDefinition {
    let mut definition = definition(
        "tally.leave_group",
        r#"{
          "type": "object",
          "required": ["group_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        &[],
        |ctx| {
            // LEAVING IS THE CASE WHERE `remove_group_member`'S REFUSAL IS
            // WRONG: the rows stay put, the leaver stops being a current
            // member, and "departed" is DERIVED rather than a column.
            let group_id = ctx.required_str("group_id")?.to_owned();
            let party_id = ctx
                .optional_str("party_id")
                .map_or_else(|| owner_party_id(ctx), |id| Ok(id.to_owned()))?;
            let circle_id = circle_of(ctx, &group_id)?;
            let present = count(
                ctx,
                "SELECT COUNT(*) FROM social_circle_member
                  WHERE circle_id = ?1 AND party_id = ?2",
                &[&circle_id, &party_id],
            )?;
            if present == 0 {
                return Err(invalid(
                    "party_id",
                    "that person is not a member of this group",
                ));
            }
            let on_ledger = count(
                ctx,
                "SELECT (SELECT COUNT(*) FROM tally_expense e
                           WHERE e.group_id = ?1 AND e.paid_by = ?2)
                      + (SELECT COUNT(*) FROM tally_expense_split s
                           JOIN tally_expense e ON e.expense_id = s.expense_id
                          WHERE e.group_id = ?1 AND s.party_id = ?2)",
                &[&group_id, &party_id],
            )? > 0;
            ctx.connection().execute(
                "DELETE FROM social_circle_member WHERE circle_id = ?1 AND party_id = ?2",
                rusqlite::params![circle_id, party_id],
            )?;
            Ok(serde_json::json!({
                "group_id": group_id,
                "party_id": party_id,
                "on_ledger": on_ledger,
            }))
        },
    );
    definition.preconditions = GROUP_EXISTS;
    definition
}

fn archive_group() -> CommandDefinition {
    let mut definition = definition(
        "tally.archive_group",
        r#"{
          "type": "object",
          "required": ["group_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "archived": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        &[],
        |ctx| {
            // Archive is not delete and deliberately does NOT require a settled
            // balance — that is exactly the state you most want out of the way
            // without losing. Absent means archive; `false` un-archives, so one
            // command owns both directions.
            let group_id = ctx.required_str("group_id")?.to_owned();
            let archived_at = match ctx
                .input
                .get("archived")
                .and_then(serde_json::Value::as_bool)
            {
                Some(false) => None,
                _ => Some(ctx.now.clone()),
            };
            ctx.connection().execute(
                "UPDATE tally_group SET archived_at = ?1 WHERE group_id = ?2",
                rusqlite::params![archived_at, group_id],
            )?;
            Ok(serde_json::json!({ "group_id": group_id, "archived_at": archived_at }))
        },
    );
    definition.preconditions = GROUP_EXISTS;
    definition
}

fn set_group_simplification() -> CommandDefinition {
    let mut definition = definition(
        "tally.set_group_simplification",
        r#"{
          "type": "object",
          "required": ["group_id", "simplify"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "simplify": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        &[],
        |ctx| {
            // Off by default, PER GROUP: simplification rewires who owes whom,
            // and the flag is the only thing stored — the transfers are derived
            // at read time by the one engine.
            let group_id = ctx.required_str("group_id")?.to_owned();
            let on = ctx
                .input
                .get("simplify")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(|| invalid("simplify", "a required boolean is missing"))?;
            ctx.connection().execute(
                "UPDATE tally_group SET simplify_opt_in = ?1 WHERE group_id = ?2",
                rusqlite::params![i64::from(on), group_id],
            )?;
            Ok(serde_json::json!({ "group_id": group_id, "simplify_opt_in": on }))
        },
    );
    definition.preconditions = GROUP_EXISTS;
    definition
}

/// The shared body of `add_expense`: everything but the receipt half.
fn write_new_expense(ctx: &CommandCtx<'_, '_>, split_method: Option<&str>) -> Result<String> {
    assert_category(ctx)?;
    let group_id = ctx.optional_str("group_id").map(str::to_owned);
    let amount_minor = ctx
        .input
        .get("amount_minor")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| invalid("amount_minor", "an amount in minor units is required"))?;
    let allowed = participant_scope(ctx, group_id.as_deref())?;
    let (payers, principal) = resolve_payers(
        Some(ctx.required_str("paid_by")?),
        amount_minor,
        entries(&ctx.input, "payers", "paid_minor")?,
    )?;
    let lines = line_inputs(&ctx.input)?;
    let fx = resolve_new_expense_fx(ctx, amount_minor, group_id.as_deref())?;
    let expense_id = minted_id(ctx, "expense_id");
    let method = split_method
        .map(str::to_owned)
        .unwrap_or_else(|| split_method_of(ctx.optional_str("split_method"), lines.as_ref()));
    insert_expense_row(
        ctx,
        &expense_id,
        group_id.as_deref(),
        amount_minor,
        &principal,
        &method,
        &fx,
    )?;
    write_payers(ctx, &expense_id, group_id.as_deref(), &payers, &allowed)?;
    write_splits(
        ctx,
        &expense_id,
        group_id.as_deref(),
        amount_minor,
        &entries(&ctx.input, "splits", "share_minor")?,
        &allowed,
    )?;
    if let Some(lines) = &lines {
        write_line_items(
            ctx,
            &expense_id,
            None,
            group_id.as_deref(),
            amount_minor,
            lines,
            &allowed,
        )?;
    }
    Ok(expense_id)
}

fn add_expense() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        minted_id_is_free("expense_id_free", |ctx| {
            let Some(expense_id) = ctx.optional_str("expense_id") else {
                return Ok(None);
            };
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_expense WHERE expense_id = ?1",
                &[&expense_id],
            )?;
            Ok((found != 0).then(|| "an expense with that id already exists".to_owned()))
        }),
        CommandCondition {
            predicate: "group_exists_if_named",
            check: |ctx| (group_exists_if_named().check)(ctx),
        },
    ];
    definition(
        "tally.add_expense",
        r#"{
          "type": "object",
          "required": ["description", "amount_minor", "paid_by", "category", "splits"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer", "minimum": 1 },
            "paid_by": { "type": "string", "minLength": 1 },
            "payers": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["party_id", "paid_minor"],
                "additionalProperties": false,
                "properties": {
                  "party_id": { "type": "string", "minLength": 1 },
                  "paid_minor": { "type": "integer", "minimum": 0 }
                }
              }
            },
            "spent_on": { "type": "string" },
            "category": { "type": "string", "minLength": 1 },
            "splits": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "required": ["party_id", "share_minor"],
                "additionalProperties": false,
                "properties": {
                  "party_id": { "type": "string", "minLength": 1 },
                  "share_minor": { "type": "integer", "minimum": 0 }
                }
              }
            },
            "split_method": { "type": "string", "minLength": 1 },
            "split_params": { "type": "object" },
            "line_items": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["kind", "description", "amount_minor", "allocations"],
                "additionalProperties": false,
                "properties": {
                  "kind": { "type": "string", "enum": ["item", "tax", "tip"] },
                  "description": { "type": "string", "minLength": 1 },
                  "amount_minor": { "type": "integer" },
                  "allocations": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": ["party_id", "share_minor"],
                      "additionalProperties": false,
                      "properties": {
                        "party_id": { "type": "string", "minLength": 1 },
                        "share_minor": { "type": "integer", "minimum": 0 }
                      }
                    }
                  }
                }
              }
            },
            "original_amount_minor": { "type": "integer", "minimum": 1 },
            "original_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "settlement_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "rate_scaled": { "type": "integer", "minimum": 1 },
            "rate_scale": { "type": "integer", "minimum": 0, "maximum": 12 },
            "rate_source": { "type": "string", "minLength": 1 },
            "rate_date": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        PRE,
        &[],
        |ctx| {
            let expense_id = write_new_expense(ctx, None)?;
            Ok(serde_json::json!({ "expense_id": expense_id }))
        },
    )
}

fn add_receipt_expense() -> CommandDefinition {
    definition(
        "tally.add_receipt_expense",
        r#"{
          "type": "object",
          "required": ["description", "amount_minor", "paid_by", "category", "splits",
                       "staged_sha", "ocr_text", "line_items"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer", "minimum": 1 },
            "paid_by": { "type": "string", "minLength": 1 },
            "payers": { "type": "array" },
            "spent_on": { "type": "string" },
            "category": { "type": "string", "minLength": 1 },
            "splits": { "type": "array", "minItems": 1 },
            "split_params": { "type": "object" },
            "staged_sha": { "type": "string", "minLength": 64, "maxLength": 64 },
            "ocr_text": { "type": "string", "minLength": 1, "maxLength": 200000 },
            "line_items": { "type": "array" },
            "original_amount_minor": { "type": "integer", "minimum": 1 },
            "original_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "settlement_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "rate_scaled": { "type": "integer", "minimum": 1 },
            "rate_scale": { "type": "integer", "minimum": 0, "maximum": 12 },
            "rate_source": { "type": "string", "minLength": 1 },
            "rate_date": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        &[],
        &[],
        |ctx| {
            // THE BYTE PLANE IS NOT THIS LANE'S (D-1020-T3b). v0 claims the
            // staged blob (`ctx.blobs.claimStaged`), mints a `core_content_item`
            // and its representation, attaches it as the `role='receipt'`
            // attachment and writes the OCR text through the enrichment plane —
            // four planes, none of them Tally's, and Tally is a RECORD-ONLY app
            // (`docs/blueprint-seats.md` S2, `byteBearing: false`).
            //
            // Refused rather than half-done: writing the expense and silently
            // dropping the receipt would leave a member believing their photo
            // was filed, which is the failure mode `core.add_party` refuses a
            // reach scheme for.
            let _ = ctx.required_str("staged_sha")?;
            Err(VaultError::NotImplemented {
                name: format!(
                    "{} — the staged-blob, content and enrichment planes it needs are the media \
                     lane's; `tally.add_expense` with `line_items` records the same division \
                     without the photo",
                    ctx.command
                ),
            })
        },
    )
}

fn edit_expense() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_live",
        check: |ctx| (expense_live().check)(ctx),
    }];
    definition(
        "tally.edit_expense",
        r#"{
          "type": "object",
          "required": ["expense_id", "description", "amount_minor", "paid_by", "category", "splits"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer", "minimum": 1 },
            "paid_by": { "type": "string", "minLength": 1 },
            "payers": { "type": "array" },
            "spent_on": { "type": "string" },
            "category": { "type": "string", "minLength": 1 },
            "splits": { "type": "array", "minItems": 1 },
            "split_method": { "type": "string", "minLength": 1 },
            "split_params": { "type": "object" },
            "line_items": { "type": "array" },
            "original_amount_minor": { "type": "integer", "minimum": 1 },
            "original_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "settlement_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "rate_scaled": { "type": "integer", "minimum": 1 },
            "rate_scale": { "type": "integer", "minimum": 0, "maximum": 12 },
            "rate_source": { "type": "string", "minLength": 1 },
            "rate_date": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            assert_category(ctx)?;
            let expense_id = ctx.required_str("expense_id")?.to_owned();
            let amount_minor = ctx
                .input
                .get("amount_minor")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| invalid("amount_minor", "an amount in minor units is required"))?;
            // THE LIVE FX PROVENANCE IS PRESERVED unless the caller supplies a
            // rate set, and an amount change that the stored rate no longer
            // reproduces is either retargeted (same currency, identity rate) or
            // REFUSED (cross-currency). A silent re-label would make the row
            // claim a conversion nobody did.
            let existing: HeldFx = ctx
                .connection()
                .query_row(
                    "SELECT group_id, original_amount_minor, original_currency,
                                settlement_currency, rate_scaled, rate_scale, rate_source, rate_date
                           FROM tally_expense WHERE expense_id = ?1",
                    [&expense_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    },
                )
                .map_err(|_| invalid("expense_id", "there is no expense with that id"))?;
            let (
                group_id,
                held_original,
                held_original_currency,
                held_settlement,
                held_scaled,
                held_scale,
                held_source,
                held_date,
            ) = existing;
            let base = base_currency(ctx.connection());
            let has_fx_input = [
                "original_amount_minor",
                "original_currency",
                "settlement_currency",
                "rate_scaled",
                "rate_scale",
                "rate_source",
                "rate_date",
            ]
            .iter()
            .any(|key| ctx.input.get(*key).is_some());
            let original_currency = ctx
                .optional_str("original_currency")
                .map(str::to_owned)
                .or_else(|| held_original_currency.clone())
                .unwrap_or_else(|| base.clone())
                .to_uppercase();
            let settlement_currency = ctx
                .optional_str("settlement_currency")
                .map(str::to_owned)
                .or_else(|| held_settlement.clone())
                .unwrap_or_else(|| base.clone())
                .to_uppercase();
            let same = original_currency == settlement_currency;
            let rate_scale = ctx
                .input
                .get("rate_scale")
                .and_then(serde_json::Value::as_i64)
                .or(held_scale)
                .unwrap_or(RATE_SCALE);
            let identity = 10_i64.pow(u32::try_from(rate_scale).unwrap_or(0));
            let (original_amount, rate_scaled, rate_source, rate_date) = if has_fx_input {
                let original_amount = ctx
                    .input
                    .get("original_amount_minor")
                    .and_then(serde_json::Value::as_i64)
                    .or(held_original)
                    .unwrap_or(amount_minor);
                let rate_scaled = ctx
                    .input
                    .get("rate_scaled")
                    .and_then(serde_json::Value::as_i64)
                    .or(held_scaled)
                    .or_else(|| same.then_some(identity));
                let rate_source = ctx
                    .optional_str("rate_source")
                    .map(str::to_owned)
                    .or_else(|| held_source.clone())
                    .or_else(|| same.then(|| "identity".to_owned()));
                let rate_date = ctx
                    .optional_str("rate_date")
                    .map(str::to_owned)
                    .or_else(|| held_date.clone())
                    .or_else(|| ctx.optional_str("spent_on").map(str::to_owned))
                    .unwrap_or_else(|| day_of(&ctx.now));
                (original_amount, rate_scaled, rate_source, rate_date)
            } else {
                let held_original = held_original.unwrap_or(amount_minor);
                let held_scaled = held_scaled.or_else(|| same.then_some(identity));
                let reproduces = held_scaled.is_some_and(|scaled| {
                    convert_currency_minor(held_original, scaled, rate_scale)
                        .is_ok_and(|amount| amount == amount_minor)
                });
                if reproduces {
                    (
                        held_original,
                        held_scaled,
                        held_source
                            .clone()
                            .or_else(|| same.then(|| "identity".to_owned())),
                        held_date
                            .clone()
                            .or_else(|| ctx.optional_str("spent_on").map(str::to_owned))
                            .unwrap_or_else(|| day_of(&ctx.now)),
                    )
                } else if same {
                    // Same-currency amount change — retarget the identity rate.
                    (
                        amount_minor,
                        Some(identity),
                        Some("identity".to_owned()),
                        ctx.optional_str("spent_on")
                            .map_or_else(|| day_of(&ctx.now), str::to_owned),
                    )
                } else {
                    return Err(invalid(
                        "amount_minor",
                        "cross-currency amount changes need a rate, source, and effective date",
                    ));
                }
            };
            let Some(rate_scaled) = rate_scaled else {
                return Err(invalid(
                    "rate_scaled",
                    "cross-currency expenses need a rate, source, and effective date",
                ));
            };
            if !same && rate_source.is_none() {
                return Err(invalid(
                    "rate_source",
                    "cross-currency expenses need a rate, source, and effective date",
                ));
            }
            if convert_currency_minor(original_amount, rate_scaled, rate_scale)? != amount_minor {
                return Err(invalid(
                    "amount_minor",
                    "settlement amount does not match the supplied rate",
                ));
            }

            let allowed = participant_scope(ctx, group_id.as_deref())?;
            let (payers, principal) = resolve_payers(
                Some(ctx.required_str("paid_by")?),
                amount_minor,
                entries(&ctx.input, "payers", "paid_minor")?,
            )?;
            let lines = line_inputs(&ctx.input)?;
            let (revision_id, undo_until) =
                record_expense_revision(ctx, &expense_id, "edit", lines.is_some())?;
            let split_params_json = ctx
                .input
                .get("split_params")
                .map(|params| serde_json::to_string(params).unwrap_or_else(|_| "{}".to_owned()));
            ctx.connection().execute(
                "UPDATE tally_expense
                    SET description = ?1, amount_minor = ?2, paid_by = ?3,
                        split_method = COALESCE(?4, split_method),
                        split_params_json = COALESCE(?5, split_params_json),
                        spent_on = COALESCE(?6, spent_on), category = ?7,
                        original_amount_minor = ?8, original_currency = ?9,
                        settlement_currency = ?10, rate_scaled = ?11, rate_scale = ?12,
                        rate_source = ?13, rate_date = ?14
                  WHERE expense_id = ?15",
                rusqlite::params![
                    ctx.required_str("description")?,
                    amount_minor,
                    principal,
                    ctx.optional_str("split_method"),
                    split_params_json,
                    ctx.optional_str("spent_on"),
                    ctx.required_str("category")?,
                    original_amount,
                    original_currency,
                    settlement_currency,
                    rate_scaled,
                    rate_scale,
                    rate_source.unwrap_or_else(|| "identity".to_owned()),
                    rate_date,
                    expense_id,
                ],
            )?;
            write_payers(ctx, &expense_id, group_id.as_deref(), &payers, &allowed)?;
            write_splits(
                ctx,
                &expense_id,
                group_id.as_deref(),
                amount_minor,
                &entries(&ctx.input, "splits", "share_minor")?,
                &allowed,
            )?;
            if let Some(lines) = &lines {
                // Re-typed lines keep the expense's receipt, so an edit by line
                // does not orphan its photo.
                let receipt_id: Option<String> = ctx
                    .connection()
                    .query_row(
                        "SELECT attachment_id FROM core_attachment
                          WHERE target_type = 'tally.expense' AND target_id = ?1
                            AND role = 'receipt' ORDER BY attachment_id LIMIT 1",
                        [&expense_id],
                        |row| row.get(0),
                    )
                    .ok();
                write_line_items(
                    ctx,
                    &expense_id,
                    receipt_id.as_deref(),
                    group_id.as_deref(),
                    amount_minor,
                    lines,
                    &allowed,
                )?;
            }
            Ok(serde_json::json!({
                "expense_id": expense_id,
                "revision_id": revision_id,
                "undo_until": undo_until,
            }))
        },
    )
}

fn delete_expense() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_live",
        check: |ctx| (expense_live().check)(ctx),
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_trashed",
        check: |ctx| (expense_trashed().check)(ctx),
    }];
    definition(
        "tally.delete_expense",
        r#"{
          "type": "object",
          "required": ["expense_id"],
          "additionalProperties": false,
          "properties": { "expense_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Once,
        PRE,
        POST,
        |ctx| {
            // Reversible grace-window trash (#441), not a hard delete. The
            // splits stay put: the balance engine ignores them once the expense
            // leaves the `deleted_at IS NULL` window, and the sweep cascades
            // them at purge.
            let expense_id = ctx.required_str("expense_id")?.to_owned();
            let (revision_id, undo_until) =
                record_expense_revision(ctx, &expense_id, "trash", false)?;
            ctx.connection().execute(
                "UPDATE tally_expense SET deleted_at = ?1, purge_at = ?2 WHERE expense_id = ?3",
                rusqlite::params![ctx.now, plus_days(&ctx.now, PURGE_WINDOW_DAYS)?, expense_id],
            )?;
            Ok(serde_json::json!({
                "expense_id": expense_id,
                "revision_id": revision_id,
                "undo_until": undo_until,
            }))
        },
    )
}

fn restore_expense() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_trashed",
        check: |ctx| (expense_trashed().check)(ctx),
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_live",
        check: |ctx| (expense_live().check)(ctx),
    }];
    definition(
        "tally.restore_expense",
        r#"{
          "type": "object",
          "required": ["expense_id"],
          "additionalProperties": false,
          "properties": { "expense_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        PRE,
        POST,
        |ctx| {
            // Lossless restore within the grace window — the splits were never
            // dropped.
            let expense_id = ctx.required_str("expense_id")?.to_owned();
            record_expense_revision(ctx, &expense_id, "restore", false)?;
            ctx.connection().execute(
                "UPDATE tally_expense SET deleted_at = NULL, purge_at = NULL
                  WHERE expense_id = ?1",
                [&expense_id],
            )?;
            Ok(serde_json::json!({ "expense_id": expense_id }))
        },
    )
}

fn undo_expense() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_exists_including_trash",
        check: |ctx| {
            let expense_id = ctx.required_str("expense_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_expense WHERE expense_id = ?1",
                &[&expense_id],
            )?;
            Ok((found != 1).then(|| "there is no expense with that id".to_owned()))
        },
    }];
    definition(
        "tally.undo_expense",
        r#"{
          "type": "object",
          "required": ["expense_id", "revision_id"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "revision_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        PRE,
        &[],
        |ctx| {
            let expense_id = ctx.required_str("expense_id")?.to_owned();
            let revision_id = ctx.required_str("revision_id")?.to_owned();
            // THE WINDOW IS PART OF THE CLAIM: a revision past its
            // `undo_until`, or one already undone, is not an undo a member was
            // promised. Both are refused with the same sentence, because to a
            // member they are the same fact — the offer has gone.
            let snapshot: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT snapshot_json FROM core_entity_revision
                      WHERE revision_id = ?1 AND entity_type = 'tally.expense'
                        AND entity_id = ?2 AND undone_at IS NULL AND undo_until >= ?3",
                    rusqlite::params![revision_id, expense_id, ctx.now],
                    |row| row.get(0),
                )
                .ok();
            let Some(snapshot) = snapshot else {
                return Err(invalid(
                    "revision_id",
                    "that change can no longer be undone",
                ));
            };
            let snapshot: serde_json::Value =
                serde_json::from_str(&snapshot).map_err(|source| VaultError::Json {
                    context: format!("revision `{revision_id}`'s snapshot is not JSON"),
                    source,
                })?;
            restore_expense_snapshot(ctx, &expense_id, &snapshot)?;
            let changed = ctx.connection().execute(
                "UPDATE core_entity_revision SET undone_at = ?1
                  WHERE revision_id = ?2 AND undone_at IS NULL",
                rusqlite::params![ctx.now, revision_id],
            )?;
            if changed != 1 {
                return Err(VaultError::Invariant {
                    context: "the revision was undone by another writer".to_owned(),
                });
            }
            Ok(serde_json::json!({
                "expense_id": expense_id,
                "revision_id": revision_id,
            }))
        },
    )
}

fn reallocate_receipt() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_live",
        check: |ctx| (expense_live().check)(ctx),
    }];
    definition(
        "tally.reallocate_receipt",
        r#"{
          "type": "object",
          "required": ["expense_id", "line_items", "splits"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "line_items": { "type": "array" },
            "splits": { "type": "array", "minItems": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            // LINES AND DERIVED SPLITS IN ONE INVOCATION: apart, a receipt
            // whose lines were re-cut but whose splits were not no longer
            // reconciles. Both totals are re-validated and the AMOUNT never
            // changes here.
            let expense_id = ctx.required_str("expense_id")?.to_owned();
            let (amount_minor, group_id, receipt_id): (i64, Option<String>, Option<String>) = ctx
                .connection()
                .query_row(
                    "SELECT e.amount_minor, e.group_id,
                            (SELECT a.attachment_id FROM core_attachment a
                              WHERE a.target_type = 'tally.expense'
                                AND a.target_id = e.expense_id AND a.role = 'receipt'
                              ORDER BY a.attachment_id LIMIT 1)
                       FROM tally_expense e WHERE e.expense_id = ?1",
                    [&expense_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|_| invalid("expense_id", "there is no expense with that id"))?;
            let allowed = participant_scope(ctx, group_id.as_deref())?;
            let lines = line_inputs(&ctx.input)?.unwrap_or_default();
            // The pre-image carries the lines, so ONE undo puts back both
            // halves.
            let (revision_id, undo_until) =
                record_expense_revision(ctx, &expense_id, "reallocate", true)?;
            write_line_items(
                ctx,
                &expense_id,
                receipt_id.as_deref(),
                group_id.as_deref(),
                amount_minor,
                &lines,
                &allowed,
            )?;
            write_splits(
                ctx,
                &expense_id,
                group_id.as_deref(),
                amount_minor,
                &entries(&ctx.input, "splits", "share_minor")?,
                &allowed,
            )?;
            Ok(serde_json::json!({
                "expense_id": expense_id,
                "revision_id": revision_id,
                "undo_until": undo_until,
            }))
        },
    )
}

fn settle_up() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[minted_id_is_free("settlement_id_free", |ctx| {
        let Some(settlement_id) = ctx.optional_str("settlement_id") else {
            return Ok(None);
        };
        let found = count(
            ctx,
            "SELECT COUNT(*) FROM tally_settlement WHERE settlement_id = ?1",
            &[&settlement_id],
        )?;
        Ok((found != 0).then(|| "a settlement with that id already exists".to_owned()))
    })];
    definition(
        "tally.settle_up",
        r#"{
          "type": "object",
          "required": ["from_party", "to_party", "amount_minor"],
          "additionalProperties": false,
          "properties": {
            "settlement_id": { "type": "string", "minLength": 1 },
            "from_party": { "type": "string", "minLength": 1 },
            "to_party": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer", "minimum": 1 },
            "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
            "group_id": { "type": "string", "minLength": 1 },
            "paid_on": { "type": "string" }
          }
        }"#,
        Idempotency::Once,
        PRE,
        &[],
        |ctx| {
            let from_party = ctx.required_str("from_party")?.to_owned();
            let to_party = ctx.required_str("to_party")?.to_owned();
            if from_party == to_party {
                return Err(invalid(
                    "to_party",
                    "a settlement needs two different people",
                ));
            }
            let group_id = ctx.optional_str("group_id").map(str::to_owned);
            if let Some(group_id) = &group_id {
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM tally_group WHERE group_id = ?1",
                    &[group_id],
                )?;
                if found != 1 {
                    return Err(invalid("group_id", "there is no group with that id"));
                }
            }
            // MEMBERSHIP (#916, adversarial BUG-4). `add_expense` has always
            // refused a payer outside the group; `settle_up` checked nothing,
            // so a payment could be recorded between two people who are not on
            // the ledger it lands in — and then counted in its balances.
            let allowed = participant_scope(ctx, group_id.as_deref())?;
            for party_id in [&from_party, &to_party] {
                if !allowed.contains(party_id) {
                    return Err(invalid(
                        "from_party",
                        if group_id.is_some() {
                            "a settlement is between two members of the group"
                        } else {
                            "a settlement is between you and a Tally friend"
                        },
                    ));
                }
            }
            let settlement_id = minted_id(ctx, "settlement_id");
            let paid_on = ctx
                .optional_str("paid_on")
                .map_or_else(|| day_of(&ctx.now), str::to_owned);
            let amount = ctx
                .input
                .get("amount_minor")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| invalid("amount_minor", "an amount in minor units is required"))?;
            let group_money = group_currency(ctx.connection(), group_id.as_deref());
            let currency = ctx
                .optional_str("currency")
                .map(str::to_owned)
                .or_else(|| group_money.clone())
                .unwrap_or_else(|| base_currency(ctx.connection()))
                .to_uppercase();
            // WHAT WAS PAID, IN WHAT (#916, R1 / adversarial BUG-5). A
            // settlement in a money the group's ledger is not kept in cannot be
            // counted in it, so it is refused rather than converted.
            if let Some(group_money) = &group_money
                && &currency != group_money
            {
                return Err(invalid(
                    "currency",
                    format!(
                        "this group's ledger is in {group_money}: a settlement in {currency} cannot be counted in it"
                    ),
                ));
            }

            // THE OWNER'S MONEY ACTUALLY MOVED: emit the canonical transaction
            // and bind it. Friend-to-friend settlements touch no owner pool.
            let me = owner_party_id(ctx)?;
            let mut txn_id: Option<String> = None;
            if from_party == me || to_party == me {
                let owner_pays = from_party == me;
                let other_id = if owner_pays { &to_party } else { &from_party };
                let account_id = settlement_account_id(ctx, &me)?;
                let other: Option<String> = ctx
                    .connection()
                    .query_row(
                        "SELECT display_name FROM core_party WHERE party_id = ?1",
                        [other_id],
                        |row| row.get(0),
                    )
                    .ok();
                let minted = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO core_transaction
                       (txn_id, account_id, posted_at, amount_minor, currency, direction, status,
                        transfer_group_id, counterparty_party_id, description,
                        category_concept_id, external_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'posted', NULL, ?7, ?8, NULL, ?9)",
                    rusqlite::params![
                        minted,
                        account_id,
                        format!("{paid_on}T00:00:00Z"),
                        amount,
                        currency,
                        if owner_pays { "debit" } else { "credit" },
                        other_id,
                        other.map_or_else(
                            || "Tally settlement".to_owned(),
                            |name| format!("Tally settlement — {name}")
                        ),
                        // The external id keeps a replay idempotent: the same
                        // settlement never posts twice.
                        format!("tally:settlement:{settlement_id}"),
                    ],
                )?;
                txn_id = Some(minted);
            }
            ctx.connection().execute(
                "INSERT INTO tally_settlement
                   (settlement_id, group_id, from_party, to_party, amount_minor, currency,
                    paid_on, txn_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    settlement_id,
                    group_id,
                    from_party,
                    to_party,
                    amount,
                    currency,
                    paid_on,
                    txn_id,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({
                "settlement_id": settlement_id,
                "txn_id": txn_id,
            }))
        },
    )
}

/// The canonical pool `settle_up`'s transactions post against: one per vault,
/// minted lazily on the first owner-party settlement.
fn settlement_account_id(ctx: &CommandCtx<'_, '_>, owner_id: &str) -> Result<String> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT account_id FROM core_account
              WHERE owner_party_id = ?1 AND name = 'Tally settlements'",
            [owner_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(account_id) = existing {
        return Ok(account_id);
    }
    let account_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_account
           (account_id, owner_party_id, name, kind, currency, institution_party_id,
            external_ref, is_asset, opened_at, closed_at)
         VALUES (?1, ?2, 'Tally settlements', 'cash', ?3, NULL, NULL, 1, NULL, NULL)",
        rusqlite::params![account_id, owner_id, base_currency(ctx.connection())],
    )?;
    Ok(account_id)
}

fn bind_txn() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "txn_exists",
        check: |ctx| {
            let txn_id = ctx.required_str("txn_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_transaction WHERE txn_id = ?1",
                &[&txn_id],
            )?;
            Ok((found != 1).then(|| "there is no transaction with that id".to_owned()))
        },
    }];
    definition(
        "tally.bind_txn",
        r#"{
          "type": "object",
          "required": ["txn_id"],
          "additionalProperties": false,
          "properties": {
            "txn_id": { "type": "string", "minLength": 1 },
            "expense_id": { "type": "string", "minLength": 1 },
            "settlement_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            // BIND, DON'T DUPLICATE: when the bank already imported the
            // movement, Tally adopts that row rather than emitting a second
            // one.
            let txn_id = ctx.required_str("txn_id")?.to_owned();
            let expense_id = ctx.optional_str("expense_id").map(str::to_owned);
            let settlement_id = ctx.optional_str("settlement_id").map(str::to_owned);
            if expense_id.is_some() == settlement_id.is_some() {
                return Err(invalid(
                    "expense_id",
                    "bind exactly one of `expense_id` or `settlement_id`",
                ));
            }
            if let Some(expense_id) = &expense_id {
                let changed = ctx.connection().execute(
                    "UPDATE tally_expense SET txn_id = ?1 WHERE expense_id = ?2",
                    rusqlite::params![txn_id, expense_id],
                )?;
                if changed != 1 {
                    return Err(invalid("expense_id", "there is no expense with that id"));
                }
            } else if let Some(settlement_id) = &settlement_id {
                let changed = ctx.connection().execute(
                    "UPDATE tally_settlement SET txn_id = ?1 WHERE settlement_id = ?2",
                    rusqlite::params![txn_id, settlement_id],
                )?;
                if changed != 1 {
                    return Err(invalid(
                        "settlement_id",
                        "there is no settlement with that id",
                    ));
                }
            }
            Ok(serde_json::json!({ "txn_id": txn_id }))
        },
    )
}

fn set_expense_memo() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "expense_live",
        check: |ctx| (expense_live().check)(ctx),
    }];
    definition(
        "tally.set_expense_memo",
        r#"{
          "type": "object",
          "required": ["expense_id", "note"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "note": { "type": "string" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            // THE OWNER'S REMARK IS ENTITY-SCOPED MEANING (#310): a
            // `knowledge_annotation`, never a prose column on the expense —
            // and ONE running memo per entity, so an empty note CLEARS it
            // rather than storing an empty remark.
            let expense_id = ctx.required_str("expense_id")?.to_owned();
            let note = ctx.required_str("note")?.to_owned();
            ctx.connection().execute(
                "DELETE FROM knowledge_annotation
                  WHERE target_type = 'tally.expense' AND target_id = ?1 AND kind = 'memo'",
                [&expense_id],
            )?;
            if !note.trim().is_empty() {
                let annotation_id = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO knowledge_annotation
                       (annotation_id, target_type, target_id, kind, body, author_party_id,
                        created_at, updated_at)
                     VALUES (?1, 'tally.expense', ?2, 'memo', ?3, ?4, ?5, ?5)",
                    rusqlite::params![
                        annotation_id,
                        expense_id,
                        note,
                        owner_party_id(ctx)?,
                        ctx.now
                    ],
                )?;
            }
            Ok(serde_json::json!({ "expense_id": expense_id }))
        },
    )
}

fn nudge() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "person_known",
        check: |ctx| {
            let party_id = ctx.required_str("party_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                &[&party_id],
            )?;
            Ok((found != 1).then(|| "there is nobody with that id to remind".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "nudge_recorded",
        check: |ctx| {
            let party_id = ctx.required_str("party_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM tally_nudge WHERE party_id = ?1 AND prepared_at = ?2",
                &[&party_id, &ctx.now],
            )?;
            Ok((found < 1).then(|| "the reminder was not recorded".to_owned()))
        },
    }];
    let mut definition = definition(
        "tally.nudge",
        r#"{
          "type": "object",
          "required": ["party_id", "as_of_minor"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "as_of_minor": { "type": "integer" },
            "note": { "type": "string", "maxLength": 500 }
          }
        }"#,
        Idempotency::Once,
        PRE,
        POST,
        |ctx| {
            // THE APP NEVER FIRES ONE. Executing it writes ONE row saying a
            // reminder was prepared; `sent` is stated and always false, because
            // no delivery path exists.
            let nudge_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO tally_nudge
                   (nudge_id, party_id, group_id, as_of_minor, note, prepared_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![
                    nudge_id,
                    ctx.required_str("party_id")?,
                    ctx.optional_str("group_id"),
                    ctx.input
                        .get("as_of_minor")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0),
                    ctx.optional_str("note"),
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({
                "nudge_id": nudge_id,
                "prepared_at": ctx.now,
                "sent": false,
            }))
        },
    );
    // THE FIRST OF TALLY'S TWO COMMAND-LEVEL CONFIRMS: `confirm` parks every
    // non-owner caller, and an app handler is by definition one — so a nudge
    // an assistant proposes lands in Waiting rather than being prepared.
    definition.confirm = true;
    definition
}

// ---------------------------------------------------------------------------
// The recurrence three.
// ---------------------------------------------------------------------------

/// The sentence every occurrence-level recurrence command refuses with.
fn recurrence_plane_missing(command: &str) -> VaultError {
    VaultError::NotImplemented {
        name: format!(
            "{command} — it needs the civil-time plane (`expandRecurrence` over a series' own \
             zone), which is the schedule lane's port; a second expander here is exactly the \
             drift #996 R21 (ONT-25) was filed for"
        ),
    }
}

/// `describeRecurrence`, ported: the one part of the recurrence plane with no
/// zone and no expansion in it (`packages/core/src/time/recurrence-summary.ts`).
///
/// It is what `save_recurring_expense` REFUSES on: a rule the summariser cannot
/// phrase is a rule the product does not support, and accepting it would store
/// a template no surface can describe and no expander will honour.
fn describe_recurrence(rrule: &str) -> Option<String> {
    let mut parts: std::collections::BTreeMap<&str, &str> = std::collections::BTreeMap::new();
    for piece in rrule.split(';') {
        let (key, value) = piece.split_once('=')?;
        parts.insert(key.trim(), value.trim());
    }
    let frequency = parts.get("FREQ")?.to_uppercase();
    let interval: u32 = parts
        .get("INTERVAL")
        .map_or(Ok(1), |value| value.parse())
        .ok()?;
    if interval == 0 {
        return None;
    }
    // BYMONTHDAY and the rest are on the expander's unsupported list
    // (`rrule-support.ts:26-34`): they pin occurrences to days of the month
    // while the expander steps from the anchor day.
    for unsupported in ["BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYSETPOS"] {
        if parts.contains_key(unsupported) {
            return None;
        }
    }
    let unit = match frequency.as_str() {
        "DAILY" => "day",
        "WEEKLY" => "week",
        "MONTHLY" => "month",
        "YEARLY" => "year",
        _ => return None,
    };
    Some(if interval == 1 {
        format!("Every {unit}")
    } else {
        format!("Every {interval} {unit}s")
    })
}

/// Weights resolved to minor units against a total, the remainder to the last
/// party — the same allocation an expense's splits get.
fn allocated_splits(total: i64, splits: &[(String, i64)]) -> Vec<(String, i64)> {
    let mut ordered: Vec<(String, i64)> = splits.to_vec();
    ordered.sort_by(|left, right| left.0.cmp(&right.0));
    let weight_total: i64 = ordered.iter().map(|(_, weight)| *weight).sum();
    if weight_total <= 0 {
        return Vec::new();
    }
    let mut assigned = 0;
    let last = ordered.len().saturating_sub(1);
    ordered
        .iter()
        .enumerate()
        .map(|(index, (party_id, weight))| {
            let share = if index == last {
                total - assigned
            } else {
                total * weight / weight_total
            };
            assigned += share;
            (party_id.clone(), share)
        })
        .collect()
}

fn save_recurring_expense() -> CommandDefinition {
    definition(
        "tally.save_recurring_expense",
        r#"{
          "type": "object",
          "required": ["group_id", "description", "original_amount_minor", "original_currency",
                       "settlement_currency", "paid_by", "category", "splits", "rrule",
                       "anchor_start", "tz"],
          "additionalProperties": false,
          "properties": {
            "template_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "original_amount_minor": { "type": "integer", "minimum": 1 },
            "original_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "settlement_currency": { "type": "string", "pattern": "^[A-Za-z]{3}$" },
            "paid_by": { "type": "string", "minLength": 1 },
            "category": { "type": "string", "minLength": 1 },
            "splits": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "required": ["party_id", "weight"],
                "additionalProperties": false,
                "properties": {
                  "party_id": { "type": "string", "minLength": 1 },
                  "weight": { "type": "integer", "minimum": 1 }
                }
              }
            },
            "rrule": { "type": "string", "minLength": 1 },
            "anchor_start": { "type": "string", "minLength": 1 },
            "tz": { "type": "string", "minLength": 1 },
            "rate_scaled": { "type": "integer", "minimum": 1 },
            "rate_scale": { "type": "integer", "minimum": 0, "maximum": 12 },
            "rate_source": { "type": "string", "minLength": 1 },
            "rate_date": { "type": "string", "minLength": 1 },
            "status": { "type": "string", "enum": ["active", "paused", "ended"] }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        &[],
        |ctx| {
            let rrule = ctx.required_str("rrule")?.to_owned();
            let Some(preview) = describe_recurrence(&rrule) else {
                return Err(invalid("rrule", "enter a supported recurrence rule"));
            };
            let group_id = ctx.required_str("group_id")?.to_owned();
            let paid_by = ctx.required_str("paid_by")?.to_owned();
            let members = participant_scope(ctx, Some(&group_id))?;
            if !members.contains(&paid_by) {
                return Err(invalid("paid_by", "payer is not a member of this group"));
            }
            let weights = entries(&ctx.input, "splits", "weight")?;
            if weights.is_empty() {
                return Err(invalid("splits", "choose at least one split"));
            }
            let mut seen: BTreeSet<&str> = BTreeSet::new();
            for (party_id, weight) in &weights {
                if *weight <= 0 || !members.contains(party_id) || !seen.insert(party_id.as_str()) {
                    return Err(invalid(
                        "splits",
                        "recurring split weights must be unique group members",
                    ));
                }
            }
            let original_amount = ctx
                .input
                .get("original_amount_minor")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| invalid("original_amount_minor", "an amount is required"))?;
            let original_currency = ctx.required_str("original_currency")?.to_uppercase();
            let settlement_currency = ctx.required_str("settlement_currency")?.to_uppercase();
            let rate_scaled = ctx
                .input
                .get("rate_scaled")
                .and_then(serde_json::Value::as_i64);
            let rate_scale = ctx
                .input
                .get("rate_scale")
                .and_then(serde_json::Value::as_i64);
            if original_currency != settlement_currency
                && (rate_scaled.is_none()
                    || ctx.optional_str("rate_source").is_none()
                    || ctx.optional_str("rate_date").is_none())
            {
                return Err(invalid(
                    "rate_scaled",
                    "cross-currency expenses need a rate, source, and effective date",
                ));
            }
            let template_id = minted_id(ctx, "template_id");
            ctx.connection().execute(
                "INSERT INTO tally_recurring_expense
                   (template_id, group_id, description, original_amount_minor, original_currency,
                    settlement_currency, paid_by, category, rrule, anchor_start, tz, rate_scaled,
                    rate_scale, rate_source, rate_date, status, last_materialized_start,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                         NULL, ?17, ?17)
                 ON CONFLICT(template_id) DO UPDATE SET
                   group_id = excluded.group_id, description = excluded.description,
                   original_amount_minor = excluded.original_amount_minor,
                   original_currency = excluded.original_currency,
                   settlement_currency = excluded.settlement_currency,
                   paid_by = excluded.paid_by, category = excluded.category,
                   rrule = excluded.rrule, anchor_start = excluded.anchor_start,
                   tz = excluded.tz, rate_scaled = excluded.rate_scaled,
                   rate_scale = excluded.rate_scale, rate_source = excluded.rate_source,
                   rate_date = excluded.rate_date, status = excluded.status,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    template_id,
                    group_id,
                    ctx.required_str("description")?.trim(),
                    original_amount,
                    original_currency,
                    settlement_currency,
                    paid_by,
                    ctx.required_str("category")?,
                    rrule,
                    ctx.required_str("anchor_start")?,
                    // ONE NAME FOR A ZONE (#916, R4): the column and the input
                    // agree, and three readers spelling it three ways is the
                    // drift that made every skip silently vanish.
                    ctx.required_str("tz")?,
                    rate_scaled,
                    rate_scale.or_else(|| rate_scaled.map(|_| RATE_SCALE)),
                    ctx.optional_str("rate_source"),
                    ctx.optional_str("rate_date"),
                    ctx.optional_str("status").unwrap_or("active"),
                    ctx.now,
                ],
            )?;
            // THE SPLIT IS ROWS (#916, D3 / review 10.4): a JSON array of
            // `{party_id, weight}` put party ids where identity merge could not
            // see them, the purge cascade could not reach them, and no
            // constraint could hold their shares to the amount.
            let template_amount = convert_currency_minor(
                original_amount,
                rate_scaled.unwrap_or(10_i64.pow(u32::try_from(RATE_SCALE).unwrap_or(6))),
                rate_scale.unwrap_or(RATE_SCALE),
            )?;
            ctx.connection().execute(
                "DELETE FROM tally_recurring_expense_split WHERE template_id = ?1",
                [&template_id],
            )?;
            for (party_id, share) in allocated_splits(template_amount, &weights) {
                ctx.connection().execute(
                    "INSERT INTO tally_recurring_expense_split
                       (template_id, party_id, share_minor) VALUES (?1, ?2, ?3)",
                    rusqlite::params![template_id, party_id, share],
                )?;
            }
            Ok(serde_json::json!({ "template_id": template_id, "preview": preview }))
        },
    )
}

fn materialize_recurring_expense() -> CommandDefinition {
    let mut definition = definition(
        "tally.materialize_recurring_expense",
        r#"{
          "type": "object",
          "required": ["template_id", "original_start_local"],
          "additionalProperties": false,
          "properties": {
            "template_id": { "type": "string", "minLength": 1 },
            "original_start_local": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        &[],
        |ctx| {
            // The template's own state is checked first, so a paused series
            // refuses for the reason a member can act on rather than for the
            // missing plane.
            let template_id = ctx.required_str("template_id")?;
            let status: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT status FROM tally_recurring_expense WHERE template_id = ?1",
                    [template_id],
                    |row| row.get(0),
                )
                .ok();
            match status.as_deref() {
                None => Err(invalid("template_id", "recurring expense not found")),
                Some("active") => Err(recurrence_plane_missing(ctx.command)),
                Some(_) => Err(invalid("template_id", "recurring expense is not active")),
            }
        },
    );
    // v0's Tally `online_only` list is exactly this command (census E4 of wave
    // 3): materialising an occurrence is withheld offline, because a seat that
    // queued one could write a second copy of the same occurrence when the
    // gateway had already written it.
    definition.online_only = true;
    definition
}

fn edit_recurring_expense_occurrence() -> CommandDefinition {
    definition(
        "tally.edit_recurring_expense_occurrence",
        r#"{
          "type": "object",
          "required": ["template_id", "original_start_local", "scope", "action"],
          "additionalProperties": false,
          "properties": {
            "template_id": { "type": "string", "minLength": 1 },
            "original_start_local": { "type": "string", "minLength": 1 },
            "scope": { "type": "string", "enum": ["occurrence", "future", "series"] },
            "action": { "type": "string", "enum": ["skip", "override"] },
            "override": { "type": "object" }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        &[],
        |ctx| {
            let template_id = ctx.required_str("template_id")?.to_owned();
            let scope = ctx.required_str("scope")?.to_owned();
            let action = ctx.required_str("action")?.to_owned();
            let exists = count(
                ctx,
                "SELECT COUNT(*) FROM tally_recurring_expense WHERE template_id = ?1",
                &[&template_id],
            )?;
            if exists != 1 {
                return Err(invalid("template_id", "recurring expense not found"));
            }
            if scope != "series" {
                // AN EXCEPTION FOR A DATE THE SERIES NEVER LANDS ON IS A ROW
                // THAT MATCHES NOTHING (#916, adversarial BUG-3), so v0 checks
                // that the wall clock IS an occurrence before writing one —
                // and that check is the expander this port does not have.
                return Err(recurrence_plane_missing(ctx.command));
            }
            if action == "skip" {
                ctx.connection().execute(
                    "UPDATE tally_recurring_expense SET status = 'ended', updated_at = ?1
                      WHERE template_id = ?2",
                    rusqlite::params![ctx.now, template_id],
                )?;
                return Ok(serde_json::json!({
                    "template_id": template_id,
                    "scope": scope,
                }));
            }
            // A SERIES EDIT MAY NOT STRAND ITS EXCEPTIONS (#916, review 3.1 /
            // adversarial BUG-3): changing the rule re-expands the series, and
            // an exception whose wall clock is no longer an occurrence stops
            // matching — the skip disappears and the occurrence the member
            // removed comes back. v0 counts the stranded ones by re-expanding;
            // without the expander the honest answer is to refuse the edit
            // while any occurrence exception exists, which is strictly safer
            // than writing one and hoping.
            let exceptions = count(
                ctx,
                "SELECT COUNT(*) FROM schedule_recurrence_exception
                  WHERE target_type = 'tally.recurring_expense' AND target_id = ?1
                    AND scope = 'occurrence'",
                &[&template_id],
            )?;
            if exceptions > 0 {
                return Err(invalid(
                    "override",
                    format!(
                        "this series has {exceptions} occurrence exception(s); re-anchoring them \
                         needs the civil-time plane, so the edit is refused rather than stranding \
                         them"
                    ),
                ));
            }
            // Only the fields v0 admits, and only scalars: an override is an
            // edit to the series, not a door into the row.
            let mut sets: Vec<String> = Vec::new();
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            for key in [
                "description",
                "original_amount_minor",
                "rate_scaled",
                "rate_scale",
                "rate_source",
                "rate_date",
                "rrule",
            ] {
                let Some(value) = ctx.input.get("override").and_then(|body| body.get(key)) else {
                    continue;
                };
                if let Some(text) = value.as_str() {
                    sets.push(format!("{} = ?", crate::log::quoted(key)));
                    binds.push(Box::new(text.to_owned()));
                } else if let Some(number) = value.as_i64() {
                    sets.push(format!("{} = ?", crate::log::quoted(key)));
                    binds.push(Box::new(number));
                }
            }
            if !sets.is_empty() {
                sets.push("updated_at = ?".to_owned());
                binds.push(Box::new(ctx.now.clone()));
                binds.push(Box::new(template_id.clone()));
                let sql = format!(
                    "UPDATE tally_recurring_expense SET {} WHERE template_id = ?",
                    sets.join(", ")
                );
                let params: Vec<&dyn rusqlite::ToSql> =
                    binds.iter().map(std::convert::AsRef::as_ref).collect();
                ctx.connection().prepare(&sql)?.execute(params.as_slice())?;
            }
            Ok(serde_json::json!({ "template_id": template_id, "scope": scope }))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_twenty_three_are_here_with_valid_schemas() {
        let definitions = definitions();
        // The catalogue's own count for the tally schema (apps census §2.8).
        assert_eq!(definitions.len(), 23);
        let mut names: Vec<&str> = definitions.iter().map(|entry| entry.name).collect();
        names.sort_unstable();
        let unique = names.len();
        names.dedup();
        assert_eq!(names.len(), unique, "a name is registered twice");
        for definition in &definitions {
            assert!(definition.name.starts_with("tally."));
            assert_eq!(definition.owner_schema, "tally");
            let schema: serde_json::Value = serde_json::from_str(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            assert_eq!(
                schema.get("additionalProperties"),
                Some(&serde_json::Value::Bool(false)),
                "{} is open",
                definition.name
            );
            assert!(
                jsonschema::validator_for(&schema).is_ok(),
                "{}'s schema does not compile",
                definition.name
            );
        }
    }

    #[test]
    fn the_two_command_level_confirms_are_the_ones_the_census_counted() {
        let confirmed: Vec<&str> = definitions()
            .iter()
            .filter(|definition| definition.confirm)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(
            confirmed,
            vec!["tally.remove_group_member", "tally.nudge"],
            "tally has exactly two command-level confirms (census A0)"
        );
    }

    #[test]
    fn only_materialize_is_withheld_offline() {
        let online: Vec<&str> = definitions()
            .iter()
            .filter(|definition| definition.online_only)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(online, vec!["tally.materialize_recurring_expense"]);
    }

    #[test]
    fn the_idempotency_split_is_v0s_fourteen_and_nine() {
        let once = definitions()
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::Once)
            .count();
        let idempotent = definitions()
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::Idempotent)
            .count();
        // Census A0's per-schema tally: tally 23 = 14 idempotent / 9 once.
        assert_eq!((idempotent, once), (14, 9));
    }

    #[test]
    fn a_rule_the_summariser_cannot_phrase_is_refused_rather_than_stored() {
        assert_eq!(
            describe_recurrence("FREQ=MONTHLY").as_deref(),
            Some("Every month")
        );
        assert_eq!(
            describe_recurrence("FREQ=WEEKLY;INTERVAL=2").as_deref(),
            Some("Every 2 weeks")
        );
        assert_eq!(describe_recurrence("FREQ=MONTHLY;BYMONTHDAY=13"), None);
        assert_eq!(describe_recurrence("FREQ=HOURLY"), None);
        assert_eq!(describe_recurrence("nonsense"), None);
    }

    #[test]
    fn payers_must_sum_and_the_named_payer_must_be_among_them() {
        let (payers, principal) = resolve_payers(Some("a"), 100, Vec::new()).expect("single payer");
        assert_eq!(payers, vec![("a".to_owned(), 100)]);
        assert_eq!(principal, "a");
        assert!(
            resolve_payers(Some("a"), 100, vec![("a".to_owned(), 60)]).is_err(),
            "a payer set that does not sum to the amount is refused"
        );
        assert!(
            resolve_payers(Some("c"), 100, vec![("a".to_owned(), 100)]).is_err(),
            "the named payer has to be one of them"
        );
        // With no named payer the largest contributor stands in.
        let (_, principal) =
            resolve_payers(None, 100, vec![("a".to_owned(), 40), ("b".to_owned(), 60)])
                .expect("largest stands in");
        assert_eq!(principal, "b");
    }

    #[test]
    fn the_conversion_reproduces_the_settlement_amount_exactly() {
        // 1.000000 is the identity rate at scale 6.
        assert_eq!(convert_currency_minor(4_200, 1_000_000, 6).unwrap(), 4_200);
        // Half up, in integers: 100 * 1.005 = 100.5 -> 101.
        assert_eq!(convert_currency_minor(100, 1_005_000, 6).unwrap(), 101);
        assert!(convert_currency_minor(0, 1_000_000, 6).is_err());
        assert!(convert_currency_minor(100, 1_000_000, 13).is_err());
    }

    #[test]
    fn weights_allocate_to_the_last_party_and_never_lose_a_penny() {
        let splits = vec![
            ("a".to_owned(), 1),
            ("b".to_owned(), 1),
            ("c".to_owned(), 1),
        ];
        let allocated = allocated_splits(10_001, &splits);
        assert_eq!(
            allocated.iter().map(|(_, share)| share).sum::<i64>(),
            10_001
        );
        assert_eq!(allocated.last().unwrap().1, 10_001 - 3_333 * 2);
    }
}
