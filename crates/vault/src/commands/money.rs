//! The 20 `money.*` commands — Money's write surface (#1099).
//!
//! Money reads a bank or card statement the member imported and says where it
//! went. The canonical rows are the spine's own (`core_account`,
//! `core_transaction`); this module is the only writer of the six `money_*`
//! tables the baseline founds and of the few columns of the spine rows that a
//! member decides. `docs/decisions.md#money-1099` holds the rulings, and the
//! comments in `contracts/migrations/001_baseline.sql` state why each table is
//! what it is.
//!
//! ## The doctrine these commands keep
//!
//! - **Nothing stored is a figure.** No balance, total or rollup is written; a
//!   screen derives them at read time. What IS written is a decision (a name, a
//!   category, a plan, a rule) or a fact the statement stated (a line, a
//!   checkpoint).
//! - **An imported line is never edited.** The schema refuses it
//!   (`core_transaction_money_rows_are_fixed`); the only moves are a category
//!   and `void`, which never deletes.
//! - **Importing the same file twice writes nothing.** A line is keyed by the
//!   `external_id` the importer derived (`ofx:<FITID>` or `csv:<hex digest>`) and the
//!   unique index makes a second arrival `already_in`, a value, not an error.
//! - **There is no replay ledger** (R-1088-12), so a write the shell may re-offer
//!   is idempotent by its content (`import_transactions`, `set_*`, `categorize`)
//!   or by an id the phone minted first (`add_account`, `add_rule`,
//!   `add_category`). `the_idempotency_split_is_seventeen_and_three` pins which.
//! - **A refusal is a value.** A command that cannot proceed says why in a
//!   precondition's sentence, with a stable predicate name a shell can switch on;
//!   an import's per-line refusals are in its output, not an error.
//! - **The member's name for an account lives in `money_account`**, because the
//!   spine's account is append-only. `core_account.name` keeps the words the
//!   account was founded with and no reader of Money looks at it.
//!
//! ## Rule matching (seam S2)
//!
//! `apply_rule_to_history` and the app crate's `rules.rs` implement ONE spec,
//! independently, and a test in the crate runs both against the same fixture.
//! The spec is in the root plan's "Rule semantics"; the pieces are
//! [`normalise`], [`wildcard_matches`] and [`Rule::specificity`] below, each
//! with the words of the spec beside it. Whitespace is Rust's
//! `char::is_whitespace` (Unicode `White_Space`), so a non-breaking space
//! collapses like a space does.

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// The categories scheme (the baseline seeds it on every file).
pub const CATEGORIES_SCHEME_URI: &str = "urn:centraid:money:categories";

/// The flags scheme an archived category carries its mark in: one judgment, one
/// mechanism (the star is the same kind of tag).
const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
const ARCHIVED_NOTATION: &str = "archived";

/// The relation two halves of one movement of the member's own money carry.
const TRANSFER_NOTATION: &str = "transfer";

/// What a vault refuses in one `import_transactions` call. The app enforces its
/// own byte and row limits before it asks (R-1099-7); this is the vault's own
/// ceiling and the schema's `maxItems`.
pub const IMPORT_ROWS_MAX: usize = 20_000;

// ---------------------------------------------------------------------------
// Small helpers. SQL lives in `crates/vault` by construction.
// ---------------------------------------------------------------------------

fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

fn count(ctx: &CommandCtx<'_, '_>, sql: &str, bind: &[&dyn rusqlite::ToSql]) -> Result<i64> {
    Ok(ctx.connection().query_row(sql, bind, |row| row.get(0))?)
}

fn str_of<'a>(ctx: &'a CommandCtx<'_, '_>, key: &str) -> Option<&'a str> {
    ctx.input.get(key).and_then(serde_json::Value::as_str)
}

fn base_currency(connection: &Connection) -> String {
    connection
        .query_row("SELECT base_currency FROM core_vault LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap_or_else(|_| "USD".to_owned())
}

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
        context: "this vault has no owner yet; enrol one before using Money".to_owned(),
    })
}

/// A civil date as the schema's GLOB spells it, and a real day of a real month.
fn real_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let year: i32 = text[0..4].parse().unwrap_or(0);
    let month: u32 = text[5..7].parse().unwrap_or(0);
    let day: u32 = text[8..10].parse().unwrap_or(0);
    if !(1900..=2200).contains(&year) || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let last = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= last
}

/// `YYYY-MM` with a month that exists.
fn real_month(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && text[0..4]
            .parse::<i32>()
            .is_ok_and(|y| (1900..=2200).contains(&y))
        && text[5..7]
            .parse::<u32>()
            .is_ok_and(|m| (1..=12).contains(&m))
}

fn currency_code(text: &str) -> bool {
    text.len() == 3 && text.bytes().all(|b| b.is_ascii_uppercase())
}

/// The spine's coarse kind a finer Money kind belongs to.
fn core_kind(kind: &str) -> &'static str {
    match kind {
        "credit_card" => "credit",
        "cash" => "cash",
        _ => "depository",
    }
}

fn is_money_account(ctx: &CommandCtx<'_, '_>, account_id: &str) -> Result<bool> {
    Ok(count(
        ctx,
        "SELECT COUNT(*) FROM money_account WHERE account_id = ?1",
        &[&account_id],
    )? == 1)
}

fn account_currency(ctx: &CommandCtx<'_, '_>, account_id: &str) -> Result<String> {
    Ok(ctx.connection().query_row(
        "SELECT currency FROM core_account WHERE account_id = ?1",
        [account_id],
        |row| row.get(0),
    )?)
}

/// A transaction on a Money account, as the commands need to see it.
struct Txn {
    account_id: String,
    currency: String,
    direction: String,
    status: String,
}

fn money_txn(ctx: &CommandCtx<'_, '_>, txn_id: &str) -> Result<Option<Txn>> {
    match ctx.connection().query_row(
        "SELECT t.account_id, t.currency, t.direction, t.status
           FROM core_transaction t
           JOIN money_account a ON a.account_id = t.account_id
          WHERE t.txn_id = ?1",
        [txn_id],
        |row| {
            Ok(Txn {
                account_id: row.get(0)?,
                currency: row.get(1)?,
                direction: row.get(2)?,
                status: row.get(3)?,
            })
        },
    ) {
        Ok(txn) => Ok(Some(txn)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn is_category(ctx: &CommandCtx<'_, '_>, concept_id: &str) -> Result<bool> {
    Ok(count(
        ctx,
        "SELECT COUNT(*) FROM core_concept c
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE s.uri = ?1 AND c.concept_id = ?2",
        &[&CATEGORIES_SCHEME_URI, &concept_id],
    )? == 1)
}

fn is_archived(ctx: &CommandCtx<'_, '_>, concept_id: &str) -> Result<bool> {
    Ok(count(
        ctx,
        "SELECT COUNT(*) FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = 'core.concept' AND t.target_id = ?1
            AND s.uri = ?2 AND c.notation = ?3",
        &[&concept_id, &FLAGS_SCHEME_URI, &ARCHIVED_NOTATION],
    )? > 0)
}

fn transfer_relation(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT c.concept_id FROM core_concept c
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE s.uri = ?1 AND c.notation = ?2",
            rusqlite::params![
                crate::commands::core_links::RELATIONS_SCHEME_URI,
                TRANSFER_NOTATION
            ],
            |row| row.get::<_, String>(0),
        )
        .ok())
}

/// The id is not held by any entity: a minted id is a claim that nothing exists.
fn id_is_free(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<bool> {
    let id = ctx.required_str(key)?;
    Ok(count(
        ctx,
        "SELECT COUNT(*) FROM core_entity WHERE entity_id = ?1",
        &[&id],
    )? == 0)
}

/// End every live `transfer` link a transaction is an end of; returns how many.
fn end_transfer_links(ctx: &CommandCtx<'_, '_>, txn_id: &str) -> Result<usize> {
    let Some(relation) = transfer_relation(ctx)? else {
        return Ok(0);
    };
    Ok(ctx.connection().execute(
        "UPDATE core_link SET valid_to = ?1
          WHERE relation_concept_id = ?2 AND valid_to IS NULL
            AND from_type = 'core.transaction' AND to_type = 'core.transaction'
            AND (from_id = ?3 OR to_id = ?3)",
        rusqlite::params![ctx.now, relation, txn_id],
    )?)
}

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------

/// Every `money.*` command.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_account(),
        edit_account(),
        set_opening_balance(),
        import_transactions(),
        categorize(),
        void_transaction(),
        set_display_name(),
        link_transfer(),
        unlink_transfer(),
        set_target(),
        set_carry(),
        add_rule(),
        edit_rule(),
        delete_rule(),
        apply_rule_to_history(),
        save_import_profile(),
        record_checkpoint(),
        add_category(),
        merge_category(),
        archive_category(),
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
        owner_schema: "money",
        input_schema,
        idempotency,
        risk: Risk::Low,
        confirm: false,
        preconditions,
        postconditions,
        handler,
        sealed_input: &[],
    }
}

/// The account a command names is a Money account.
const ACCOUNT_IS_MONEY: CommandCondition = CommandCondition {
    predicate: "account_is_money",
    check: |ctx| {
        let account_id = ctx.required_str("account_id")?;
        Ok((!is_money_account(ctx, account_id)?)
            .then(|| "There is no Money account with that id.".to_owned()))
    },
};

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

fn name_is_taken(ctx: &CommandCtx<'_, '_>, name: &str, except: Option<&str>) -> Result<bool> {
    Ok(count(
        ctx,
        "SELECT COUNT(*) FROM money_account
          WHERE lower(trim(name)) = lower(trim(?1)) AND account_id IS NOT ?2",
        &[&name, &except],
    )? > 0)
}

/// Another account already carries this bank reference (compared as printed,
/// ignoring case and surrounding space). Two accounts sharing one would make an
/// OFX statement's account ambiguous.
fn external_ref_is_taken(
    ctx: &CommandCtx<'_, '_>,
    reference: &str,
    except: Option<&str>,
) -> Result<bool> {
    Ok(count(
        ctx,
        "SELECT COUNT(*) FROM core_account
          WHERE lower(trim(external_ref)) = lower(trim(?1)) AND account_id IS NOT ?2",
        &[&reference, &except],
    )? > 0)
}

fn add_account() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "account_id_free",
            check: |ctx| {
                Ok((!id_is_free(ctx, "account_id")?)
                    .then(|| "An account with that id already exists.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "name_is_present",
            check: |ctx| {
                Ok(str_of(ctx, "name")
                    .is_none_or(|name| name.trim().is_empty())
                    .then(|| "An account needs a name.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "name_is_free",
            check: |ctx| {
                let name = ctx.required_str("name")?;
                Ok(name_is_taken(ctx, name, None)?
                    .then(|| "You already have an account with that name.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "currency_is_a_code",
            check: |ctx| {
                Ok(str_of(ctx, "currency")
                    .filter(|currency| !currency_code(&currency.to_uppercase()))
                    .map(|_| "A currency is a three-letter code like USD.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "external_ref_is_free",
            check: |ctx| {
                let Some(reference) = str_of(ctx, "external_ref") else {
                    return Ok(None);
                };
                Ok(external_ref_is_taken(ctx, reference, None)?
                    .then(|| "Another account already has that bank number.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "opening_date_is_real",
            check: |ctx| {
                Ok(str_of(ctx, "opening_on")
                    .filter(|day| !real_date(day))
                    .map(|_| "That is not a real date.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "opening_balance_has_a_day",
            check: |ctx| {
                let amount = ctx
                    .input
                    .get("opening_minor")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                Ok((amount != 0 && str_of(ctx, "opening_on").is_none())
                    .then(|| "An opening balance needs the day it was true.".to_owned()))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "account_created",
        check: |ctx| {
            let account_id = ctx.required_str("account_id")?;
            Ok((!is_money_account(ctx, account_id)?)
                .then(|| "the account was not created".to_owned()))
        },
    }];
    definition(
        "money.add_account",
        r#"{
          "type": "object",
          "required": ["account_id", "name", "kind"],
          "additionalProperties": false,
          "properties": {
            "account_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 80 },
            "kind": { "enum": ["checking", "savings", "credit_card", "cash"] },
            "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
            "on_budget": { "type": "boolean" },
            "external_ref": { "type": "string", "minLength": 1, "maxLength": 64 },
            "opening_minor": { "type": "integer" },
            "opening_on": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
          }
        }"#,
        Idempotency::Once,
        PRE,
        POST,
        |ctx| {
            let account_id = ctx.required_str("account_id")?.to_owned();
            let name = ctx.required_str("name")?.trim().to_owned();
            let kind = ctx.required_str("kind")?.to_owned();
            let currency = str_of(ctx, "currency")
                .map_or_else(|| base_currency(ctx.connection()), str::to_uppercase);
            let on_budget = ctx
                .input
                .get("on_budget")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let opening_minor = ctx
                .input
                .get("opening_minor")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0);
            let opening_on = str_of(ctx, "opening_on").map(str::to_owned);
            let external_ref = str_of(ctx, "external_ref")
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_owned);
            let owner = owner_party_id(ctx)?;
            ctx.connection().execute(
                "INSERT INTO core_account
                   (account_id, owner_party_id, name, kind, currency, institution_party_id,
                    external_ref, is_asset, opened_at, closed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL, NULL)",
                rusqlite::params![
                    account_id,
                    owner,
                    name,
                    core_kind(&kind),
                    currency,
                    external_ref,
                    i64::from(kind != "credit_card")
                ],
            )?;
            ctx.connection().execute(
                "INSERT INTO money_account
                   (account_id, name, kind, on_budget, opening_minor, opening_on, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    account_id,
                    name,
                    kind,
                    i64::from(on_budget),
                    opening_minor,
                    opening_on,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "account_id": account_id, "currency": currency }))
        },
    )
}

fn edit_account() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ACCOUNT_IS_MONEY,
        CommandCondition {
            predicate: "name_is_present",
            check: |ctx| {
                Ok(str_of(ctx, "name")
                    .is_some_and(|name| name.trim().is_empty())
                    .then(|| "An account needs a name.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "name_is_free",
            check: |ctx| {
                let Some(name) = str_of(ctx, "name") else {
                    return Ok(None);
                };
                let account_id = ctx.required_str("account_id")?;
                Ok(name_is_taken(ctx, name, Some(account_id))?
                    .then(|| "You already have an account with that name.".to_owned()))
            },
        },
        CommandCondition {
            // checking and savings are one class; a card and cash are others,
            // and the spine's account kind does not change (R-1099-6).
            predicate: "kind_stays_in_its_class",
            check: |ctx| {
                let Some(kind) = str_of(ctx, "kind") else {
                    return Ok(None);
                };
                let account_id = ctx.required_str("account_id")?;
                let current: String = ctx.connection().query_row(
                    "SELECT kind FROM money_account WHERE account_id = ?1",
                    [account_id],
                    |row| row.get(0),
                )?;
                Ok((core_kind(kind) != core_kind(&current)).then(|| {
                    "An account can change between checking and savings; a card or cash is its own kind of account."
                        .to_owned()
                }))
            },
        },
        CommandCondition {
            predicate: "external_ref_is_free",
            check: |ctx| {
                let Some(reference) = str_of(ctx, "external_ref") else {
                    return Ok(None);
                };
                let account_id = ctx.required_str("account_id")?;
                Ok(external_ref_is_taken(ctx, reference, Some(account_id))?
                    .then(|| "Another account already has that bank number.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "closing_date_is_real",
            check: |ctx| {
                Ok(str_of(ctx, "closed_on")
                    .filter(|day| !real_date(day))
                    .map(|_| "That is not a real date.".to_owned()))
            },
        },
    ];
    definition(
        "money.edit_account",
        r#"{
          "type": "object",
          "required": ["account_id"],
          "additionalProperties": false,
          "properties": {
            "account_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 80 },
            "kind": { "enum": ["checking", "savings", "credit_card", "cash"] },
            "on_budget": { "type": "boolean" },
            "external_ref": { "type": ["string", "null"], "minLength": 1, "maxLength": 64 },
            "closed_on": { "type": ["string", "null"], "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let account_id = ctx.required_str("account_id")?.to_owned();
            let (name, kind, on_budget, closed_on): (String, String, i64, Option<String>) =
                ctx.connection().query_row(
                    "SELECT name, kind, on_budget, closed_on FROM money_account WHERE account_id = ?1",
                    [&account_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
            let new_name =
                str_of(ctx, "name").map_or_else(|| name.clone(), |n| n.trim().to_owned());
            let new_kind = str_of(ctx, "kind").map_or_else(|| kind.clone(), str::to_owned);
            let new_budget = ctx
                .input
                .get("on_budget")
                .and_then(serde_json::Value::as_bool)
                .map_or(on_budget, i64::from);
            let new_closed = match ctx.input.get("closed_on") {
                None => closed_on.clone(),
                Some(value) => value.as_str().map(str::to_owned),
            };
            let reference: Option<String> = ctx.connection().query_row(
                "SELECT external_ref FROM core_account WHERE account_id = ?1",
                [&account_id],
                |row| row.get(0),
            )?;
            let new_reference = match ctx.input.get("external_ref") {
                None => reference.clone(),
                Some(value) => value
                    .as_str()
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_owned),
            };
            let reference_changed = new_reference != reference;
            if reference_changed {
                ctx.connection().execute(
                    "UPDATE core_account SET external_ref = ?1 WHERE account_id = ?2",
                    rusqlite::params![new_reference, account_id],
                )?;
            }
            let changed = reference_changed
                || (&new_name, &new_kind, new_budget, &new_closed)
                    != (&name, &kind, on_budget, &closed_on);
            if (&new_name, &new_kind, new_budget, &new_closed)
                != (&name, &kind, on_budget, &closed_on)
            {
                ctx.connection().execute(
                    "UPDATE money_account SET name = ?1, kind = ?2, on_budget = ?3, closed_on = ?4
                      WHERE account_id = ?5",
                    rusqlite::params![new_name, new_kind, new_budget, new_closed, account_id],
                )?;
            }
            Ok(serde_json::json!({ "account_id": account_id, "changed": changed }))
        },
    )
}

fn set_opening_balance() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ACCOUNT_IS_MONEY,
        CommandCondition {
            predicate: "opening_date_is_real",
            check: |ctx| {
                Ok((!real_date(ctx.required_str("opening_on")?))
                    .then(|| "That is not a real date.".to_owned()))
            },
        },
        CommandCondition {
            // An opening balance is where the account stood BEFORE the rows the
            // vault holds. One dated after the earliest live row would make that
            // row count twice or not at all, so it takes a yes.
            predicate: "opening_not_after_first_transaction",
            check: |ctx| {
                if ctx
                    .input
                    .get("confirm")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    return Ok(None);
                }
                let account_id = ctx.required_str("account_id")?;
                let opening_on = ctx.required_str("opening_on")?;
                let earlier = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_transaction
                      WHERE account_id = ?1 AND status <> 'void' AND substr(posted_at, 1, 10) < ?2",
                    &[&account_id, &opening_on],
                )?;
                Ok((earlier > 0).then(|| {
                    "This account has transactions before that day. Choose an earlier day, or confirm."
                        .to_owned()
                }))
            },
        },
    ];
    definition(
        "money.set_opening_balance",
        r#"{
          "type": "object",
          "required": ["account_id", "opening_minor", "opening_on"],
          "additionalProperties": false,
          "properties": {
            "account_id": { "type": "string", "minLength": 1 },
            "opening_minor": { "type": "integer" },
            "opening_on": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
            "confirm": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let account_id = ctx.required_str("account_id")?.to_owned();
            let opening_minor = ctx
                .input
                .get("opening_minor")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| invalid("opening_minor", "an amount in minor units is required"))?;
            let opening_on = ctx.required_str("opening_on")?.to_owned();
            let changed = ctx.connection().execute(
                "UPDATE money_account SET opening_minor = ?1, opening_on = ?2
                  WHERE account_id = ?3 AND (opening_minor IS NOT ?1 OR opening_on IS NOT ?2)",
                rusqlite::params![opening_minor, opening_on, account_id],
            )? > 0;
            Ok(serde_json::json!({ "account_id": account_id, "changed": changed }))
        },
    )
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

fn import_transactions() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ACCOUNT_IS_MONEY,
        CommandCondition {
            predicate: "checkpoint_matches_the_account",
            check: |ctx| {
                let Some(checkpoint) = ctx.input.get("checkpoint") else {
                    return Ok(None);
                };
                let account_id = ctx.required_str("account_id")?;
                let currency = checkpoint
                    .get("currency")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                if !is_money_account(ctx, account_id)? {
                    return Ok(None);
                }
                if currency != account_currency(ctx, account_id)? {
                    return Ok(Some(
                        "The statement's balance is in a different currency from this account."
                            .to_owned(),
                    ));
                }
                let as_of = checkpoint
                    .get("as_of")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                Ok((!real_date(as_of))
                    .then(|| "The statement's balance date is not a real date.".to_owned()))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "every_row_has_an_outcome",
        check: |_| Ok(None),
    }];
    definition(
        "money.import_transactions",
        r#"{
          "type": "object",
          "required": ["account_id", "source", "rows"],
          "additionalProperties": false,
          "properties": {
            "account_id": { "type": "string", "minLength": 1 },
            "source": { "enum": ["csv", "ofx"] },
            "rows": {
              "type": "array",
              "maxItems": 20000,
              "items": {
                "type": "object",
                "required": ["txn_id", "external_id", "posted_on", "amount_minor", "direction", "description"],
                "additionalProperties": false,
                "properties": {
                  "txn_id": { "type": "string", "minLength": 1 },
                  "external_id": { "type": "string", "minLength": 5, "maxLength": 300 },
                  "posted_on": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                  "amount_minor": { "type": "integer", "minimum": 1 },
                  "direction": { "enum": ["debit", "credit"] },
                  "description": { "type": "string" },
                  "memo": { "type": ["string", "null"] },
                  "check_number": { "type": ["string", "null"] },
                  "bank_type": { "type": ["string", "null"] },
                  "category_concept_id": { "type": ["string", "null"] },
                  "display_name": { "type": ["string", "null"] }
                }
              }
            },
            "checkpoint": {
              "type": "object",
              "required": ["as_of", "balance_minor", "currency"],
              "additionalProperties": false,
              "properties": {
                "as_of": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                "balance_minor": { "type": "integer" },
                "currency": { "type": "string", "minLength": 3, "maxLength": 3 }
              }
            }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        POST,
        |ctx| {
            let account_id = ctx.required_str("account_id")?.to_owned();
            let source = ctx.required_str("source")?.to_owned();
            let currency = account_currency(ctx, &account_id)?;
            let rows = ctx
                .input
                .get("rows")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| invalid("rows", "a list of rows is required"))?;
            let prefix = if source == "ofx" { "ofx:" } else { "csv:" };
            let mut outcomes = Vec::with_capacity(rows.len());
            let mut categories: std::collections::BTreeMap<String, bool> = Default::default();
            for row in rows {
                let text = |key: &str| row.get(key).and_then(serde_json::Value::as_str);
                let txn_id = text("txn_id").unwrap_or_default();
                let external_id = text("external_id").unwrap_or_default();
                let refuse = |reason: &str| {
                    serde_json::json!({
                        "txn_id": txn_id, "external_id": external_id,
                        "outcome": "refused", "reason": reason,
                    })
                };
                if !external_id.starts_with(prefix) {
                    outcomes.push(refuse("external_id_not_from_source"));
                    continue;
                }
                let posted_on = text("posted_on").unwrap_or_default();
                if !real_date(posted_on) {
                    outcomes.push(refuse("bad_date"));
                    continue;
                }
                let category = text("category_concept_id");
                if let Some(category) = category {
                    let known = match categories.get(category) {
                        Some(known) => *known,
                        None => {
                            let known = is_category(ctx, category)?;
                            categories.insert(category.to_owned(), known);
                            known
                        }
                    };
                    if !known {
                        outcomes.push(refuse("unknown_category"));
                        continue;
                    }
                }
                let existing: Option<String> = ctx
                    .connection()
                    .prepare_cached(
                        "SELECT txn_id FROM core_transaction
                          WHERE account_id = ?1 AND external_id = ?2",
                    )?
                    .query_row(rusqlite::params![account_id, external_id], |r| r.get(0))
                    .ok();
                if let Some(existing) = existing {
                    outcomes.push(serde_json::json!({
                        "txn_id": existing, "external_id": external_id, "outcome": "already_in",
                    }));
                    continue;
                }
                let held: i64 = ctx
                    .connection()
                    .prepare_cached("SELECT COUNT(*) FROM core_entity WHERE entity_id = ?1")?
                    .query_row([txn_id], |r| r.get(0))?;
                if held > 0 {
                    outcomes.push(refuse("txn_id_taken"));
                    continue;
                }
                let amount = row
                    .get("amount_minor")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                ctx.connection()
                    .prepare_cached(
                        "INSERT INTO core_transaction
                           (txn_id, account_id, posted_at, amount_minor, currency, direction,
                            status, transfer_group_id, counterparty_party_id, description,
                            category_concept_id, external_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'posted', NULL, NULL, ?7, ?8, ?9)",
                    )?
                    .execute(rusqlite::params![
                        txn_id,
                        account_id,
                        format!("{posted_on}T00:00:00Z"),
                        amount,
                        currency,
                        text("direction").unwrap_or("debit"),
                        text("description").map(str::trim),
                        category,
                        external_id,
                    ])?;
                let name = text("display_name")
                    .map(str::trim)
                    .filter(|name| !name.is_empty());
                ctx.connection()
                    .prepare_cached(
                        "INSERT INTO money_transaction
                           (txn_id, display_name, display_name_source, memo, check_number,
                            bank_type, imported_from, imported_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    )?
                    .execute(rusqlite::params![
                        txn_id,
                        name,
                        name.map(|_| "rule"),
                        text("memo").filter(|m| !m.trim().is_empty()),
                        text("check_number").filter(|m| !m.trim().is_empty()),
                        text("bank_type").filter(|m| !m.trim().is_empty()),
                        source,
                        ctx.now,
                    ])?;
                outcomes.push(serde_json::json!({
                    "txn_id": txn_id, "external_id": external_id, "outcome": "inserted",
                }));
            }
            let mut checkpoint_written = false;
            if let Some(checkpoint) = ctx.input.get("checkpoint") {
                let as_of = checkpoint
                    .get("as_of")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let balance = checkpoint
                    .get("balance_minor")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                checkpoint_written =
                    upsert_checkpoint(ctx, &account_id, as_of, &source, balance, &currency)?;
            }
            Ok(serde_json::json!({
                "outcomes": outcomes,
                "checkpoint_written": checkpoint_written,
            }))
        },
    )
}

/// Write a stated balance; `true` only when a row was added or its balance moved,
/// so stating the same balance again writes nothing.
fn upsert_checkpoint(
    ctx: &CommandCtx<'_, '_>,
    account_id: &str,
    as_of: &str,
    source: &str,
    balance_minor: i64,
    currency: &str,
) -> Result<bool> {
    Ok(ctx.connection().execute(
        "INSERT INTO money_balance_checkpoint
           (account_id, as_of, source, balance_minor, currency, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (account_id, as_of, source) DO UPDATE
           SET balance_minor = excluded.balance_minor
         WHERE money_balance_checkpoint.balance_minor IS NOT excluded.balance_minor",
        rusqlite::params![account_id, as_of, source, balance_minor, currency, ctx.now],
    )? > 0)
}

fn record_checkpoint() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ACCOUNT_IS_MONEY,
        CommandCondition {
            predicate: "checkpoint_date_is_real",
            check: |ctx| {
                Ok((!real_date(ctx.required_str("as_of")?))
                    .then(|| "That is not a real date.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "checkpoint_matches_the_account",
            check: |ctx| {
                let Some(currency) = str_of(ctx, "currency") else {
                    return Ok(None);
                };
                let account_id = ctx.required_str("account_id")?;
                if !is_money_account(ctx, account_id)? {
                    return Ok(None);
                }
                Ok((currency != account_currency(ctx, account_id)?).then(|| {
                    "That balance is in a different currency from this account.".to_owned()
                }))
            },
        },
    ];
    definition(
        "money.record_checkpoint",
        r#"{
          "type": "object",
          "required": ["account_id", "as_of", "balance_minor"],
          "additionalProperties": false,
          "properties": {
            "account_id": { "type": "string", "minLength": 1 },
            "as_of": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
            "balance_minor": { "type": "integer" },
            "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
            "source": { "enum": ["ofx", "csv", "member"] }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let account_id = ctx.required_str("account_id")?.to_owned();
            let currency = account_currency(ctx, &account_id)?;
            let balance = ctx
                .input
                .get("balance_minor")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| invalid("balance_minor", "a balance in minor units is required"))?;
            let source = str_of(ctx, "source").unwrap_or("member").to_owned();
            let written = upsert_checkpoint(
                ctx,
                &account_id,
                ctx.required_str("as_of")?,
                &source,
                balance,
                &currency,
            )?;
            Ok(serde_json::json!({ "written": written }))
        },
    )
}

fn save_import_profile() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ACCOUNT_IS_MONEY,
        CommandCondition {
            predicate: "layout_names_its_columns",
            check: |ctx| {
                let mode = ctx.required_str("sign_mode")?;
                let has = |key: &str| ctx.input.get(key).is_some_and(|value| !value.is_null());
                let missing = match mode {
                    "debit_credit" => !(has("debit_col") && has("credit_col")),
                    "indicator" => {
                        !(has("amount_col") && has("indicator_col") && has("indicator_out_value"))
                    }
                    _ => !has("amount_col"),
                };
                Ok(missing
                    .then(|| "This layout does not say which columns hold the amount.".to_owned()))
            },
        },
    ];
    definition(
        "money.save_import_profile",
        r#"{
          "type": "object",
          "required": ["account_id", "header_fingerprint", "delimiter", "date_order", "sign_mode", "date_col", "desc_col"],
          "additionalProperties": false,
          "properties": {
            "account_id": { "type": "string", "minLength": 1 },
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
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let int = |key: &str| ctx.input.get(key).and_then(serde_json::Value::as_i64);
            let changed = ctx.connection().execute(
                "INSERT INTO money_import_profile
                   (account_id, header_fingerprint, delimiter, skip_lines, date_order, sign_mode,
                    date_col, amount_col, debit_col, credit_col, desc_col, memo_col,
                    indicator_col, indicator_out_value, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT (account_id, header_fingerprint) DO UPDATE SET
                   delimiter = excluded.delimiter, skip_lines = excluded.skip_lines,
                   date_order = excluded.date_order, sign_mode = excluded.sign_mode,
                   date_col = excluded.date_col, amount_col = excluded.amount_col,
                   debit_col = excluded.debit_col, credit_col = excluded.credit_col,
                   desc_col = excluded.desc_col, memo_col = excluded.memo_col,
                   indicator_col = excluded.indicator_col,
                   indicator_out_value = excluded.indicator_out_value
                 WHERE (money_import_profile.delimiter, money_import_profile.skip_lines,
                        money_import_profile.date_order, money_import_profile.sign_mode,
                        money_import_profile.date_col, money_import_profile.amount_col,
                        money_import_profile.debit_col, money_import_profile.credit_col,
                        money_import_profile.desc_col, money_import_profile.memo_col,
                        money_import_profile.indicator_col,
                        money_import_profile.indicator_out_value)
                    IS NOT (excluded.delimiter, excluded.skip_lines, excluded.date_order,
                            excluded.sign_mode, excluded.date_col, excluded.amount_col,
                            excluded.debit_col, excluded.credit_col, excluded.desc_col,
                            excluded.memo_col, excluded.indicator_col,
                            excluded.indicator_out_value)",
                rusqlite::params![
                    ctx.required_str("account_id")?,
                    ctx.required_str("header_fingerprint")?,
                    ctx.required_str("delimiter")?,
                    int("skip_lines").unwrap_or(0),
                    ctx.required_str("date_order")?,
                    ctx.required_str("sign_mode")?,
                    int("date_col"),
                    int("amount_col"),
                    int("debit_col"),
                    int("credit_col"),
                    int("desc_col"),
                    int("memo_col"),
                    int("indicator_col"),
                    str_of(ctx, "indicator_out_value"),
                    ctx.now,
                ],
            )? > 0;
            Ok(serde_json::json!({ "saved": changed }))
        },
    )
}

// ---------------------------------------------------------------------------
// Decisions about a line
// ---------------------------------------------------------------------------

fn txn_ids(ctx: &CommandCtx<'_, '_>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ctx.input
        .get("txn_ids")
        .and_then(serde_json::Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|id| seen.insert((*id).to_owned()))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn categorize() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "transactions_are_money",
            check: |ctx| {
                for id in txn_ids(ctx) {
                    if money_txn(ctx, &id)?.is_none() {
                        return Ok(Some("One of those is not a Money transaction.".to_owned()));
                    }
                }
                Ok(None)
            },
        },
        CommandCondition {
            predicate: "transactions_are_not_void",
            check: |ctx| {
                for id in txn_ids(ctx) {
                    if money_txn(ctx, &id)?.is_some_and(|txn| txn.status == "void") {
                        return Ok(Some("A removed transaction cannot be filed.".to_owned()));
                    }
                }
                Ok(None)
            },
        },
        CommandCondition {
            predicate: "category_is_known",
            check: |ctx| {
                let Some(category) = str_of(ctx, "category_concept_id") else {
                    return Ok(None);
                };
                if !is_category(ctx, category)? {
                    return Ok(Some("There is no such category.".to_owned()));
                }
                Ok(is_archived(ctx, category)?
                    .then(|| "That category is archived. Unarchive it first.".to_owned()))
            },
        },
    ];
    definition(
        "money.categorize",
        r#"{
          "type": "object",
          "required": ["txn_ids", "category_concept_id"],
          "additionalProperties": false,
          "properties": {
            "txn_ids": {
              "type": "array", "minItems": 1, "maxItems": 2000,
              "items": { "type": "string", "minLength": 1 }
            },
            "category_concept_id": { "type": ["string", "null"], "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let category = str_of(ctx, "category_concept_id").map(str::to_owned);
            let mut changed = 0usize;
            for id in txn_ids(ctx) {
                changed += ctx.connection().execute(
                    "UPDATE core_transaction SET category_concept_id = ?1
                      WHERE txn_id = ?2 AND category_concept_id IS NOT ?1",
                    rusqlite::params![category, id],
                )?;
            }
            Ok(serde_json::json!({ "changed": changed }))
        },
    )
}

fn void_transaction() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "transaction_is_money",
        check: |ctx| {
            let id = ctx.required_str("txn_id")?;
            Ok(money_txn(ctx, id)?
                .is_none()
                .then(|| "That is not a Money transaction.".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "transaction_still_exists",
        check: |ctx| {
            let id = ctx.required_str("txn_id")?;
            Ok((money_txn(ctx, id)?.is_none_or(|txn| txn.status != "void"))
                .then(|| "the transaction was not removed".to_owned()))
        },
    }];
    definition(
        "money.void_transaction",
        r#"{
          "type": "object",
          "required": ["txn_id"],
          "additionalProperties": false,
          "properties": { "txn_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        PRE,
        POST,
        |ctx| {
            let id = ctx.required_str("txn_id")?.to_owned();
            // A removed line is no half of a transfer.
            let unlinked = end_transfer_links(ctx, &id)?;
            let voided = ctx.connection().execute(
                "UPDATE core_transaction SET status = 'void' WHERE txn_id = ?1 AND status <> 'void'",
                [&id],
            )? > 0;
            Ok(serde_json::json!({ "voided": voided, "transfers_ended": unlinked }))
        },
    )
}

fn set_display_name() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "transaction_is_money",
            check: |ctx| {
                let id = ctx.required_str("txn_id")?;
                Ok(money_txn(ctx, id)?
                    .is_none()
                    .then(|| "That is not a Money transaction.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "name_is_not_blank",
            check: |ctx| {
                Ok(str_of(ctx, "display_name")
                    .is_some_and(|name| name.trim().is_empty())
                    .then(|| {
                        "A name cannot be blank. Leave it empty to use the bank's words.".to_owned()
                    }))
            },
        },
    ];
    definition(
        "money.set_display_name",
        r#"{
          "type": "object",
          "required": ["txn_id", "display_name"],
          "additionalProperties": false,
          "properties": {
            "txn_id": { "type": "string", "minLength": 1 },
            "display_name": { "type": ["string", "null"], "maxLength": 120 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let id = ctx.required_str("txn_id")?.to_owned();
            let name = str_of(ctx, "display_name").map(str::trim);
            let changed = ctx.connection().execute(
                "UPDATE money_transaction SET display_name = ?1, display_name_source = ?2
                  WHERE txn_id = ?3
                    AND (display_name IS NOT ?1 OR display_name_source IS NOT ?2)",
                rusqlite::params![name, name.map(|_| "member"), id],
            )? > 0;
            Ok(serde_json::json!({ "changed": changed }))
        },
    )
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/// `(out, in)` of two transactions: the debit and the credit.
fn transfer_ends(ctx: &CommandCtx<'_, '_>) -> Result<Option<(String, String)>> {
    let a = ctx.required_str("txn_id")?.to_owned();
    let b = ctx.required_str("other_txn_id")?.to_owned();
    let (Some(first), Some(_)) = (money_txn(ctx, &a)?, money_txn(ctx, &b)?) else {
        return Ok(None);
    };
    Ok(Some(if first.direction == "debit" {
        (a, b)
    } else {
        (b, a)
    }))
}

fn link_transfer() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "transfer_relation_known",
            check: |ctx| {
                Ok(transfer_relation(ctx)?
                    .is_none()
                    .then(|| "This vault does not know the transfer relation.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "two_different_transactions",
            check: |ctx| {
                Ok(
                    (ctx.required_str("txn_id")? == ctx.required_str("other_txn_id")?)
                        .then(|| "A transfer is between two different transactions.".to_owned()),
                )
            },
        },
        CommandCondition {
            predicate: "both_are_money_transactions",
            check: |ctx| {
                Ok(transfer_ends(ctx)?
                    .is_none()
                    .then(|| "Both must be Money transactions.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "neither_is_void",
            check: |ctx| {
                for key in ["txn_id", "other_txn_id"] {
                    let id = ctx.required_str(key)?;
                    if money_txn(ctx, id)?.is_some_and(|txn| txn.status == "void") {
                        return Ok(Some(
                            "A removed transaction cannot be part of a transfer.".to_owned(),
                        ));
                    }
                }
                Ok(None)
            },
        },
        CommandCondition {
            predicate: "different_accounts",
            check: |ctx| {
                let a = money_txn(ctx, ctx.required_str("txn_id")?)?;
                let b = money_txn(ctx, ctx.required_str("other_txn_id")?)?;
                Ok(match (a, b) {
                    (Some(a), Some(b)) if a.account_id == b.account_id => {
                        Some("A transfer moves money between two accounts.".to_owned())
                    }
                    _ => None,
                })
            },
        },
        CommandCondition {
            predicate: "opposite_directions",
            check: |ctx| {
                let a = money_txn(ctx, ctx.required_str("txn_id")?)?;
                let b = money_txn(ctx, ctx.required_str("other_txn_id")?)?;
                Ok(match (a, b) {
                    (Some(a), Some(b)) if a.direction == b.direction => Some(
                        "One side of a transfer is money out and the other money in.".to_owned(),
                    ),
                    _ => None,
                })
            },
        },
        CommandCondition {
            predicate: "same_currency",
            check: |ctx| {
                let a = money_txn(ctx, ctx.required_str("txn_id")?)?;
                let b = money_txn(ctx, ctx.required_str("other_txn_id")?)?;
                Ok(match (a, b) {
                    (Some(a), Some(b)) if a.currency != b.currency => {
                        Some("Both sides of a transfer are in the same currency.".to_owned())
                    }
                    _ => None,
                })
            },
        },
        CommandCondition {
            predicate: "not_in_another_transfer",
            check: |ctx| {
                let (Some((out, into)), Some(relation)) =
                    (transfer_ends(ctx)?, transfer_relation(ctx)?)
                else {
                    return Ok(None);
                };
                let elsewhere = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_link
                      WHERE relation_concept_id = ?1 AND valid_to IS NULL
                        AND from_type = 'core.transaction' AND to_type = 'core.transaction'
                        AND (from_id IN (?2, ?3) OR to_id IN (?2, ?3))
                        AND NOT (from_id = ?2 AND to_id = ?3)",
                    &[&relation, &out, &into],
                )?;
                Ok((elsewhere > 0)
                    .then(|| "One of those is already part of another transfer.".to_owned()))
            },
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "transfer_is_linked",
        check: |ctx| {
            let (Some((out, into)), Some(relation)) =
                (transfer_ends(ctx)?, transfer_relation(ctx)?)
            else {
                return Ok(Some("the transfer was not linked".to_owned()));
            };
            let live = count(
                ctx,
                "SELECT COUNT(*) FROM core_link
                  WHERE relation_concept_id = ?1 AND valid_to IS NULL
                    AND from_type = 'core.transaction' AND from_id = ?2
                    AND to_type = 'core.transaction' AND to_id = ?3",
                &[&relation, &out, &into],
            )?;
            Ok((live != 1).then(|| "the transfer was not linked".to_owned()))
        },
    }];
    definition(
        "money.link_transfer",
        r#"{
          "type": "object",
          "required": ["txn_id", "other_txn_id"],
          "additionalProperties": false,
          "properties": {
            "txn_id": { "type": "string", "minLength": 1 },
            "other_txn_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        POST,
        |ctx| {
            let Some((out, into)) = transfer_ends(ctx)? else {
                return Err(invalid("txn_id", "both must be Money transactions"));
            };
            let relation = transfer_relation(ctx)?
                .ok_or_else(|| invalid("relation", "no transfer relation"))?;
            // The same pair already linked: the member said it twice.
            let existing: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT link_id FROM core_link
                      WHERE relation_concept_id = ?1 AND valid_to IS NULL
                        AND from_type = 'core.transaction' AND from_id = ?2
                        AND to_type = 'core.transaction' AND to_id = ?3",
                    rusqlite::params![relation, out, into],
                    |row| row.get(0),
                )
                .ok();
            if let Some(link_id) = existing {
                return Ok(serde_json::json!({ "link_id": link_id, "linked": false }));
            }
            let link_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_link
                   (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                    valid_from, valid_to, asserted_by, provenance_id, updated_at)
                 VALUES (?1, 'core.transaction', ?2, 'core.transaction', ?3, ?4, ?5, NULL,
                         'owner', NULL, ?5)",
                rusqlite::params![link_id, out, into, relation, ctx.now],
            )?;
            Ok(serde_json::json!({ "link_id": link_id, "linked": true }))
        },
    )
}

fn unlink_transfer() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "transaction_exists",
        check: |ctx| {
            let id = ctx.required_str("txn_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM core_transaction WHERE txn_id = ?1",
                &[&id],
            )?;
            Ok((found != 1).then(|| "There is no such transaction.".to_owned()))
        },
    }];
    definition(
        "money.unlink_transfer",
        r#"{
          "type": "object",
          "required": ["txn_id"],
          "additionalProperties": false,
          "properties": { "txn_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let id = ctx.required_str("txn_id")?.to_owned();
            let ended = end_transfer_links(ctx, &id)?;
            Ok(serde_json::json!({ "unlinked": ended }))
        },
    )
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

fn set_target() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "month_is_real",
            check: |ctx| {
                Ok((!real_month(ctx.required_str("month")?))
                    .then(|| "That is not a real month.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "category_is_known",
            check: |ctx| {
                let category = ctx.required_str("category_concept_id")?;
                Ok((!is_category(ctx, category)?).then(|| "There is no such category.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "currency_is_a_code",
            check: |ctx| {
                Ok(str_of(ctx, "currency")
                    .filter(|currency| !currency_code(currency))
                    .map(|_| "A currency is a three-letter code like USD.".to_owned()))
            },
        },
    ];
    definition(
        "money.set_target",
        r#"{
          "type": "object",
          "required": ["month", "category_concept_id", "amount_minor"],
          "additionalProperties": false,
          "properties": {
            "month": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}$" },
            "category_concept_id": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": ["integer", "null"], "minimum": 0 },
            "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
            "carry": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let month = ctx.required_str("month")?.to_owned();
            let category = ctx.required_str("category_concept_id")?.to_owned();
            let Some(amount) = ctx
                .input
                .get("amount_minor")
                .and_then(serde_json::Value::as_i64)
            else {
                // `null` removes the plan for that month.
                let removed = ctx.connection().execute(
                    "DELETE FROM money_target WHERE month = ?1 AND category_concept_id = ?2",
                    rusqlite::params![month, category],
                )? > 0;
                return Ok(serde_json::json!({ "changed": removed }));
            };
            let currency = str_of(ctx, "currency")
                .map_or_else(|| base_currency(ctx.connection()), str::to_owned);
            let carry = ctx
                .input
                .get("carry")
                .and_then(serde_json::Value::as_bool)
                .map(i64::from);
            let changed = ctx.connection().execute(
                "INSERT INTO money_target
                   (month, category_concept_id, amount_minor, currency, carry, created_at)
                 VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 0), ?6)
                 ON CONFLICT (month, category_concept_id) DO UPDATE SET
                   amount_minor = excluded.amount_minor,
                   currency = excluded.currency,
                   carry = COALESCE(?5, money_target.carry)
                 WHERE money_target.amount_minor IS NOT excluded.amount_minor
                    OR money_target.currency IS NOT excluded.currency
                    OR (?5 IS NOT NULL AND money_target.carry IS NOT ?5)",
                rusqlite::params![month, category, amount, currency, carry, ctx.now],
            )? > 0;
            Ok(serde_json::json!({ "changed": changed }))
        },
    )
}

fn set_carry() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "month_is_real",
            check: |ctx| {
                Ok((!real_month(ctx.required_str("month")?))
                    .then(|| "That is not a real month.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "target_exists",
            check: |ctx| {
                let month = ctx.required_str("month")?;
                let category = ctx.required_str("category_concept_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM money_target WHERE month = ?1 AND category_concept_id = ?2",
                    &[&month, &category],
                )?;
                Ok((found != 1).then(|| "Set an amount for that month first.".to_owned()))
            },
        },
    ];
    definition(
        "money.set_carry",
        r#"{
          "type": "object",
          "required": ["month", "category_concept_id", "carry"],
          "additionalProperties": false,
          "properties": {
            "month": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}$" },
            "category_concept_id": { "type": "string", "minLength": 1 },
            "carry": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let carry = i64::from(
                ctx.input
                    .get("carry")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            );
            let changed = ctx.connection().execute(
                "UPDATE money_target SET carry = ?1
                  WHERE month = ?2 AND category_concept_id = ?3 AND carry IS NOT ?1",
                rusqlite::params![
                    carry,
                    ctx.required_str("month")?,
                    ctx.required_str("category_concept_id")?
                ],
            )? > 0;
            Ok(serde_json::json!({ "changed": changed }))
        },
    )
}

// ---------------------------------------------------------------------------
// Rules (seam S2)
// ---------------------------------------------------------------------------

/// A description as a rule sees it: trimmed, runs of whitespace collapsed to one
/// space, ASCII upper-cased (anything else is left as written).
#[must_use]
pub fn normalise(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

/// `*` is any run (including none), `?` is exactly one character, everything
/// else is literal; the whole string must match. No regular expressions.
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
    pub rule_id: String,
    pub match_kind: String,
    /// Already [`normalise`]d.
    pub pattern: String,
    pub amount_min_minor: Option<i64>,
    pub amount_max_minor: Option<i64>,
    pub account_id: Option<String>,
    pub set_category_concept_id: Option<String>,
    pub set_display_name: Option<String>,
    pub position: i64,
}

impl Rule {
    /// `is` weighs 3, `matches` 2, `contains` 1, plus 1 for each of the amount
    /// minimum, the amount maximum and the account that is set.
    #[must_use]
    pub fn specificity(&self) -> i64 {
        let kind = match self.match_kind.as_str() {
            "is" => 3,
            "matches" => 2,
            _ => 1,
        };
        kind + i64::from(self.amount_min_minor.is_some())
            + i64::from(self.amount_max_minor.is_some())
            + i64::from(self.account_id.is_some())
    }

    /// Does this rule match a line? `normalised` is the line's description after
    /// [`normalise`]; `amount_minor` is its magnitude.
    #[must_use]
    pub fn matches(&self, normalised: &str, amount_minor: i64, account_id: &str) -> bool {
        let text_ok = match self.match_kind.as_str() {
            "is" => normalised == self.pattern,
            "contains" => normalised.contains(&self.pattern),
            _ => wildcard_matches(&self.pattern, normalised),
        };
        text_ok
            && self.amount_min_minor.is_none_or(|min| amount_minor >= min)
            && self.amount_max_minor.is_none_or(|max| amount_minor <= max)
            && self.account_id.as_deref().is_none_or(|id| id == account_id)
    }
}

/// Every rule, in the order they apply: specificity ascending, then position,
/// then id — so for each action the LAST matching rule that sets it wins.
fn load_rules(connection: &Connection) -> Result<Vec<Rule>> {
    let mut statement = connection.prepare(
        "SELECT rule_id, match_kind, pattern, amount_min_minor, amount_max_minor, account_id,
                set_category_concept_id, set_display_name, position
           FROM money_rule",
    )?;
    let mut rules = statement
        .query_map([], |row| {
            Ok(Rule {
                rule_id: row.get(0)?,
                match_kind: row.get(1)?,
                pattern: normalise(&row.get::<_, String>(2)?),
                amount_min_minor: row.get(3)?,
                amount_max_minor: row.get(4)?,
                account_id: row.get(5)?,
                set_category_concept_id: row.get(6)?,
                set_display_name: row.get(7)?,
                position: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rules.sort_by(|a, b| {
        (a.specificity(), a.position, &a.rule_id).cmp(&(b.specificity(), b.position, &b.rule_id))
    });
    Ok(rules)
}

fn rule_row(ctx: &CommandCtx<'_, '_>, rule_id: &str) -> Result<Option<Rule>> {
    Ok(load_rules(ctx.connection())?
        .into_iter()
        .find(|rule| rule.rule_id == rule_id))
}

/// The raw (un-normalised) pattern, for storing and for editing.
fn stored_pattern(ctx: &CommandCtx<'_, '_>, rule_id: &str) -> Result<String> {
    Ok(ctx.connection().query_row(
        "SELECT pattern FROM money_rule WHERE rule_id = ?1",
        [rule_id],
        |row| row.get(0),
    )?)
}

/// A rule's fields as they would be after this command, or the sentence that
/// says why they could not be. Shared by `add_rule` and `edit_rule`, which read
/// their input the same way except that an edit starts from the stored rule.
#[derive(Debug, Clone)]
struct RuleDraft {
    match_kind: String,
    pattern: String,
    amount_min_minor: Option<i64>,
    amount_max_minor: Option<i64>,
    account_id: Option<String>,
    set_category_concept_id: Option<String>,
    set_display_name: Option<String>,
}

/// `field` is the value in the input if the key is present (null clears it),
/// else the base.
fn field<T: Clone>(
    ctx: &CommandCtx<'_, '_>,
    key: &str,
    base: Option<T>,
    read: impl Fn(&serde_json::Value) -> Option<T>,
) -> Option<T> {
    match ctx.input.get(key) {
        None => base,
        Some(value) => read(value),
    }
}

fn draft(ctx: &CommandCtx<'_, '_>, base: Option<&RuleDraft>) -> RuleDraft {
    let text = |value: &serde_json::Value| value.as_str().map(|s| s.trim().to_owned());
    let int = |value: &serde_json::Value| value.as_i64();
    RuleDraft {
        match_kind: str_of(ctx, "match_kind")
            .map(str::to_owned)
            .or_else(|| base.map(|b| b.match_kind.clone()))
            .unwrap_or_default(),
        pattern: str_of(ctx, "pattern")
            .map(|p| p.trim().to_owned())
            .or_else(|| base.map(|b| b.pattern.clone()))
            .unwrap_or_default(),
        amount_min_minor: field(
            ctx,
            "amount_min_minor",
            base.and_then(|b| b.amount_min_minor),
            int,
        ),
        amount_max_minor: field(
            ctx,
            "amount_max_minor",
            base.and_then(|b| b.amount_max_minor),
            int,
        ),
        account_id: field(
            ctx,
            "account_id",
            base.and_then(|b| b.account_id.clone()),
            text,
        ),
        set_category_concept_id: field(
            ctx,
            "set_category_concept_id",
            base.and_then(|b| b.set_category_concept_id.clone()),
            text,
        ),
        set_display_name: field(
            ctx,
            "set_display_name",
            base.and_then(|b| b.set_display_name.clone()),
            text,
        )
        .filter(|name| !name.is_empty()),
    }
}

fn judge_draft(ctx: &CommandCtx<'_, '_>, draft: &RuleDraft) -> Result<Option<String>> {
    if draft.pattern.is_empty() {
        return Ok(Some("A rule needs something to look for.".to_owned()));
    }
    if draft.set_category_concept_id.is_none() && draft.set_display_name.is_none() {
        return Ok(Some(
            "A rule needs a category or a name to give.".to_owned(),
        ));
    }
    if let (Some(min), Some(max)) = (draft.amount_min_minor, draft.amount_max_minor)
        && min > max
    {
        return Ok(Some(
            "The smallest amount is more than the largest.".to_owned(),
        ));
    }
    if draft.amount_min_minor.is_some_and(|min| min < 0)
        || draft.amount_max_minor.is_some_and(|max| max < 0)
    {
        return Ok(Some("An amount range is never negative.".to_owned()));
    }
    if let Some(account_id) = &draft.account_id
        && !is_money_account(ctx, account_id)?
    {
        return Ok(Some("There is no Money account with that id.".to_owned()));
    }
    if let Some(category) = &draft.set_category_concept_id {
        if !is_category(ctx, category)? {
            return Ok(Some("There is no such category.".to_owned()));
        }
        if is_archived(ctx, category)? {
            return Ok(Some("That category is archived.".to_owned()));
        }
    }
    Ok(None)
}

fn write_rule(
    ctx: &CommandCtx<'_, '_>,
    rule_id: &str,
    rule: &RuleDraft,
    position: i64,
) -> Result<bool> {
    Ok(ctx.connection().execute(
        "UPDATE money_rule SET match_kind = ?2, pattern = ?3, amount_min_minor = ?4,
                amount_max_minor = ?5, account_id = ?6, set_category_concept_id = ?7,
                set_display_name = ?8, position = ?9
          WHERE rule_id = ?1
            AND (match_kind, pattern, amount_min_minor, amount_max_minor, account_id,
                 set_category_concept_id, set_display_name, position)
                IS NOT (?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            rule_id,
            rule.match_kind,
            rule.pattern,
            rule.amount_min_minor,
            rule.amount_max_minor,
            rule.account_id,
            rule.set_category_concept_id,
            rule.set_display_name,
            position
        ],
    )? > 0)
}

fn add_rule() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "rule_id_free",
            check: |ctx| {
                Ok((!id_is_free(ctx, "rule_id")?)
                    .then(|| "A rule with that id already exists.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "rule_is_sound",
            check: |ctx| judge_draft(ctx, &draft(ctx, None)),
        },
    ];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "rule_created",
        check: |ctx| {
            let id = ctx.required_str("rule_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM money_rule WHERE rule_id = ?1",
                &[&id],
            )?;
            Ok((found != 1).then(|| "the rule was not created".to_owned()))
        },
    }];
    definition(
        "money.add_rule",
        r#"{
          "type": "object",
          "required": ["rule_id", "match_kind", "pattern"],
          "additionalProperties": false,
          "properties": {
            "rule_id": { "type": "string", "minLength": 1 },
            "match_kind": { "enum": ["is", "contains", "matches"] },
            "pattern": { "type": "string", "minLength": 1, "maxLength": 200 },
            "amount_min_minor": { "type": ["integer", "null"], "minimum": 0 },
            "amount_max_minor": { "type": ["integer", "null"], "minimum": 0 },
            "account_id": { "type": ["string", "null"], "minLength": 1 },
            "set_category_concept_id": { "type": ["string", "null"], "minLength": 1 },
            "set_display_name": { "type": ["string", "null"], "maxLength": 120 },
            "position": { "type": "integer", "minimum": 0 }
          }
        }"#,
        Idempotency::Once,
        PRE,
        POST,
        |ctx| {
            let rule_id = ctx.required_str("rule_id")?.to_owned();
            let rule = draft(ctx, None);
            let position = match ctx
                .input
                .get("position")
                .and_then(serde_json::Value::as_i64)
            {
                Some(position) => position,
                None => ctx.connection().query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM money_rule",
                    [],
                    |row| row.get(0),
                )?,
            };
            ctx.connection().execute(
                "INSERT INTO money_rule
                   (rule_id, match_kind, pattern, amount_min_minor, amount_max_minor, account_id,
                    set_category_concept_id, set_display_name, position, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    rule_id,
                    rule.match_kind,
                    rule.pattern,
                    rule.amount_min_minor,
                    rule.amount_max_minor,
                    rule.account_id,
                    rule.set_category_concept_id,
                    rule.set_display_name,
                    position,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "rule_id": rule_id, "position": position }))
        },
    )
}

/// The stored rule as a draft, with its un-normalised pattern.
fn stored_draft(ctx: &CommandCtx<'_, '_>, rule_id: &str) -> Result<Option<RuleDraft>> {
    let Some(rule) = rule_row(ctx, rule_id)? else {
        return Ok(None);
    };
    Ok(Some(RuleDraft {
        match_kind: rule.match_kind,
        pattern: stored_pattern(ctx, rule_id)?,
        amount_min_minor: rule.amount_min_minor,
        amount_max_minor: rule.amount_max_minor,
        account_id: rule.account_id,
        set_category_concept_id: rule.set_category_concept_id,
        set_display_name: rule.set_display_name,
    }))
}

fn edit_rule() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "rule_exists",
            check: |ctx| {
                let id = ctx.required_str("rule_id")?;
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM money_rule WHERE rule_id = ?1",
                    &[&id],
                )?;
                Ok((found != 1).then(|| "There is no such rule.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "rule_is_sound",
            check: |ctx| {
                let Some(base) = stored_draft(ctx, ctx.required_str("rule_id")?)? else {
                    return Ok(None);
                };
                judge_draft(ctx, &draft(ctx, Some(&base)))
            },
        },
    ];
    definition(
        "money.edit_rule",
        r#"{
          "type": "object",
          "required": ["rule_id"],
          "additionalProperties": false,
          "properties": {
            "rule_id": { "type": "string", "minLength": 1 },
            "match_kind": { "enum": ["is", "contains", "matches"] },
            "pattern": { "type": "string", "minLength": 1, "maxLength": 200 },
            "amount_min_minor": { "type": ["integer", "null"], "minimum": 0 },
            "amount_max_minor": { "type": ["integer", "null"], "minimum": 0 },
            "account_id": { "type": ["string", "null"], "minLength": 1 },
            "set_category_concept_id": { "type": ["string", "null"], "minLength": 1 },
            "set_display_name": { "type": ["string", "null"], "maxLength": 120 },
            "position": { "type": "integer", "minimum": 0 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let rule_id = ctx.required_str("rule_id")?.to_owned();
            let base = stored_draft(ctx, &rule_id)?
                .ok_or_else(|| invalid("rule_id", "there is no such rule"))?;
            let rule = draft(ctx, Some(&base));
            let current_position: i64 = ctx.connection().query_row(
                "SELECT position FROM money_rule WHERE rule_id = ?1",
                [&rule_id],
                |row| row.get(0),
            )?;
            let position = ctx
                .input
                .get("position")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(current_position);
            let changed = write_rule(ctx, &rule_id, &rule, position)?;
            Ok(serde_json::json!({ "rule_id": rule_id, "changed": changed }))
        },
    )
}

fn delete_rule() -> CommandDefinition {
    definition(
        "money.delete_rule",
        r#"{
          "type": "object",
          "required": ["rule_id"],
          "additionalProperties": false,
          "properties": { "rule_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        &[],
        &[],
        |ctx| {
            // Deleting what is not there is the same end state as deleting it.
            let deleted = ctx.connection().execute(
                "DELETE FROM money_rule WHERE rule_id = ?1",
                [ctx.required_str("rule_id")?],
            )? > 0;
            Ok(serde_json::json!({ "deleted": deleted }))
        },
    )
}

struct HistoryRow {
    txn_id: String,
    account_id: String,
    amount_minor: i64,
    description: String,
    category: Option<String>,
    name_source: Option<String>,
    name: Option<String>,
}

fn apply_rule_to_history() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "rule_exists",
        check: |ctx| {
            let Some(id) = str_of(ctx, "rule_id") else {
                return Ok(None);
            };
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM money_rule WHERE rule_id = ?1",
                &[&id],
            )?;
            Ok((found != 1).then(|| "There is no such rule.".to_owned()))
        },
    }];
    definition(
        "money.apply_rule_to_history",
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "rule_id": { "type": "string", "minLength": 1 },
            "overwrite": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let only = str_of(ctx, "rule_id").map(str::to_owned);
            let overwrite = ctx
                .input
                .get("overwrite")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let rules = load_rules(ctx.connection())?;
            let rows: Vec<HistoryRow> = {
                let mut statement = ctx.connection().prepare(
                    "SELECT t.txn_id, t.account_id, t.amount_minor, COALESCE(t.description, ''),
                            t.category_concept_id, m.display_name_source, m.display_name
                       FROM core_transaction t
                       JOIN money_account a ON a.account_id = t.account_id
                       LEFT JOIN money_transaction m ON m.txn_id = t.txn_id
                      WHERE t.status <> 'void'
                      ORDER BY t.txn_id",
                )?;
                statement
                    .query_map([], |row| {
                        Ok(HistoryRow {
                            txn_id: row.get(0)?,
                            account_id: row.get(1)?,
                            amount_minor: row.get(2)?,
                            description: row.get(3)?,
                            category: row.get(4)?,
                            name_source: row.get(5)?,
                            name: row.get(6)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let (mut matched, mut recategorised, mut renamed) = (0usize, 0usize, 0usize);
            for row in rows {
                let text = normalise(&row.description);
                let mut category: Option<&str> = None;
                let mut name: Option<&str> = None;
                let mut named_rule_matched = only.is_none();
                let mut any = false;
                for rule in &rules {
                    if !rule.matches(&text, row.amount_minor, &row.account_id) {
                        continue;
                    }
                    any = true;
                    if only.as_deref() == Some(rule.rule_id.as_str()) {
                        named_rule_matched = true;
                    }
                    if let Some(set) = &rule.set_category_concept_id {
                        category = Some(set);
                    }
                    if let Some(set) = &rule.set_display_name {
                        name = Some(set);
                    }
                }
                if !any || !named_rule_matched {
                    continue;
                }
                matched += 1;
                if let Some(category) = category
                    && (overwrite || row.category.is_none())
                    && row.category.as_deref() != Some(category)
                {
                    recategorised += ctx.connection().execute(
                        "UPDATE core_transaction SET category_concept_id = ?1 WHERE txn_id = ?2",
                        rusqlite::params![category, row.txn_id],
                    )?;
                }
                if let Some(name) = name
                    && (overwrite || row.name_source.as_deref() != Some("member"))
                    && (row.name.as_deref() != Some(name)
                        || row.name_source.as_deref() != Some("rule"))
                {
                    renamed += ctx.connection().execute(
                        "UPDATE money_transaction SET display_name = ?1, display_name_source = 'rule'
                          WHERE txn_id = ?2",
                        rusqlite::params![name, row.txn_id],
                    )?;
                }
            }
            Ok(serde_json::json!({
                "matched": matched,
                "recategorised": recategorised,
                "renamed": renamed,
            }))
        },
    )
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

fn categories_scheme_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    ctx.connection()
        .query_row(
            "SELECT scheme_id FROM core_concept_scheme WHERE uri = ?1",
            [CATEGORIES_SCHEME_URI],
            |row| row.get(0),
        )
        .map_err(|_| VaultError::Invariant {
            context: "this vault has no Money categories scheme; the baseline seeds it".to_owned(),
        })
}

fn add_category() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "category_id_free",
            check: |ctx| {
                Ok((!id_is_free(ctx, "category_id")?)
                    .then(|| "A category with that id already exists.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "name_is_present",
            check: |ctx| {
                Ok(str_of(ctx, "name")
                    .is_none_or(|name| name.trim().is_empty())
                    .then(|| "A category needs a name.".to_owned()))
            },
        },
        CommandCondition {
            // Two levels: a category goes under a group, and a group under nothing.
            predicate: "parent_is_a_group",
            check: |ctx| {
                let Some(parent) = str_of(ctx, "parent_concept_id") else {
                    return Ok(None);
                };
                if !is_category(ctx, parent)? {
                    return Ok(Some("There is no such group.".to_owned()));
                }
                let top = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_concept
                      WHERE concept_id = ?1 AND broader_concept_id IS NULL",
                    &[&parent],
                )?;
                Ok((top != 1).then(|| {
                    "A category goes under a group, not under another category.".to_owned()
                }))
            },
        },
        CommandCondition {
            predicate: "name_is_free_among_siblings",
            check: |ctx| {
                let name = ctx.required_str("name")?;
                let parent = str_of(ctx, "parent_concept_id");
                let scheme = categories_scheme_id(ctx)?;
                let taken = count(
                    ctx,
                    "SELECT COUNT(*) FROM core_concept
                      WHERE scheme_id = ?1 AND broader_concept_id IS ?2
                        AND lower(trim(pref_label)) = lower(trim(?3))",
                    &[&scheme, &parent, &name],
                )?;
                Ok((taken > 0)
                    .then(|| "There is already a category with that name there.".to_owned()))
            },
        },
    ];
    definition(
        "money.add_category",
        r#"{
          "type": "object",
          "required": ["category_id", "name"],
          "additionalProperties": false,
          "properties": {
            "category_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 60 },
            "parent_concept_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        PRE,
        &[],
        |ctx| {
            let id = ctx.required_str("category_id")?.to_owned();
            let scheme = categories_scheme_id(ctx)?;
            let notation = format!("custom.{id}");
            ctx.connection().execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, broader_concept_id, stable_id,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?3, ?6, ?6)",
                rusqlite::params![
                    id,
                    scheme,
                    notation,
                    ctx.required_str("name")?.trim(),
                    str_of(ctx, "parent_concept_id"),
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "category_id": id }))
        },
    )
}

fn merge_category() -> CommandDefinition {
    static PRE: &[CommandCondition] =
        &[
            CommandCondition {
                predicate: "both_are_categories",
                check: |ctx| {
                    let from = ctx.required_str("from_concept_id")?;
                    let into = ctx.required_str("into_concept_id")?;
                    Ok((!(is_category(ctx, from)? && is_category(ctx, into)?))
                        .then(|| "There is no such category.".to_owned()))
                },
            },
            CommandCondition {
                predicate: "two_different_categories",
                check: |ctx| {
                    Ok((ctx.required_str("from_concept_id")?
                        == ctx.required_str("into_concept_id")?)
                    .then(|| "Choose a different category to merge into.".to_owned()))
                },
            },
            CommandCondition {
                predicate: "merged_category_has_no_children",
                check: |ctx| {
                    let from = ctx.required_str("from_concept_id")?;
                    let children = count(
                        ctx,
                        "SELECT COUNT(*) FROM core_concept WHERE broader_concept_id = ?1",
                        &[&from],
                    )?;
                    Ok((children > 0)
                        .then(|| "Merge or move the categories inside it first.".to_owned()))
                },
            },
        ];
    let mut merge = definition(
        "money.merge_category",
        r#"{
          "type": "object",
          "required": ["from_concept_id", "into_concept_id"],
          "additionalProperties": false,
          "properties": {
            "from_concept_id": { "type": "string", "minLength": 1 },
            "into_concept_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let from = ctx.required_str("from_concept_id")?.to_owned();
            let into = ctx.required_str("into_concept_id")?.to_owned();
            let connection = ctx.connection();
            let transactions = connection.execute(
                "UPDATE core_transaction SET category_concept_id = ?2 WHERE category_concept_id = ?1",
                rusqlite::params![from, into],
            )?;
            let rules = connection.execute(
                "UPDATE money_rule SET set_category_concept_id = ?2 WHERE set_category_concept_id = ?1",
                rusqlite::params![from, into],
            )?;
            // Plans: where the destination already has one for that month the two
            // are added (a plan for both is the sum, in one currency) and the
            // source's is dropped; otherwise the plan simply moves.
            let months: Vec<String> = {
                let mut statement = connection
                    .prepare("SELECT month FROM money_target WHERE category_concept_id = ?1")?;
                statement
                    .query_map([&from], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for month in &months {
                let source: (i64, String, i64) = connection.query_row(
                    "SELECT amount_minor, currency, carry FROM money_target
                      WHERE month = ?1 AND category_concept_id = ?2",
                    rusqlite::params![month, from],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                let destination: Option<(i64, String, i64)> = connection
                    .query_row(
                        "SELECT amount_minor, currency, carry FROM money_target
                          WHERE month = ?1 AND category_concept_id = ?2",
                        rusqlite::params![month, into],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .ok();
                match destination {
                    None => {
                        connection.execute(
                            "UPDATE money_target SET category_concept_id = ?3
                              WHERE month = ?1 AND category_concept_id = ?2",
                            rusqlite::params![month, from, into],
                        )?;
                    }
                    Some((amount, currency, carry)) => {
                        if currency == source.1 {
                            connection.execute(
                                "UPDATE money_target SET amount_minor = ?3, carry = ?4
                                  WHERE month = ?1 AND category_concept_id = ?2",
                                rusqlite::params![
                                    month,
                                    into,
                                    amount + source.0,
                                    carry.max(source.2)
                                ],
                            )?;
                        }
                        connection.execute(
                            "DELETE FROM money_target WHERE month = ?1 AND category_concept_id = ?2",
                            rusqlite::params![month, from],
                        )?;
                    }
                }
            }
            // The concept leaves; its entity row goes with it and takes any tag
            // (an archive mark) with it.
            connection.execute("DELETE FROM core_concept WHERE concept_id = ?1", [&from])?;
            Ok(serde_json::json!({
                "transactions": transactions,
                "rules": rules,
                "targets": months.len(),
            }))
        },
    );
    merge.risk = Risk::Medium;
    merge
}

fn archive_category() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "category_exists",
        check: |ctx| {
            let id = ctx.required_str("concept_id")?;
            Ok((!is_category(ctx, id)?).then(|| "There is no such category.".to_owned()))
        },
    }];
    definition(
        "money.archive_category",
        r#"{
          "type": "object",
          "required": ["concept_id", "archived"],
          "additionalProperties": false,
          "properties": {
            "concept_id": { "type": "string", "minLength": 1 },
            "archived": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        &[],
        |ctx| {
            let id = ctx.required_str("concept_id")?.to_owned();
            let archived = ctx
                .input
                .get("archived")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let now_archived = is_archived(ctx, &id)?;
            if archived == now_archived {
                return Ok(serde_json::json!({ "changed": false }));
            }
            let scheme =
                crate::commands::core::find_or_create_scheme(ctx, FLAGS_SCHEME_URI, "Flags")?;
            let flag: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
                    rusqlite::params![scheme, ARCHIVED_NOTATION],
                    |row| row.get(0),
                )
                .ok();
            let flag = if let Some(flag) = flag {
                flag
            } else {
                let flag = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO core_concept
                       (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'Archived', ?4, ?4)",
                    rusqlite::params![flag, scheme, ARCHIVED_NOTATION, ctx.now],
                )?;
                flag
            };
            if archived {
                let tag_id = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        confidence, tagged_at, updated_at)
                     VALUES (?1, 'core.concept', ?2, ?3, ?4, NULL, ?5, ?5)",
                    rusqlite::params![
                        tag_id,
                        id,
                        flag,
                        crate::commands::core::actor_party_id(ctx)?,
                        ctx.now
                    ],
                )?;
            } else {
                ctx.connection().execute(
                    "DELETE FROM core_tag
                      WHERE target_type = 'core.concept' AND target_id = ?1 AND concept_id = ?2",
                    rusqlite::params![id, flag],
                )?;
            }
            Ok(serde_json::json!({ "changed": true }))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_idempotency_split_is_seventeen_and_three() {
        let defs = definitions();
        let once = defs
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::Once)
            .count();
        let idempotent = defs
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::Idempotent)
            .count();
        // Once: the three whose id the phone mints (account, rule, category).
        assert_eq!((idempotent, once), (17, 3));
        assert_eq!(defs.len(), 20);
        let once_names: Vec<&str> = defs
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::Once)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(
            once_names,
            ["money.add_account", "money.add_rule", "money.add_category"]
        );
    }

    #[test]
    fn a_description_is_trimmed_collapsed_and_ascii_uppercased() {
        assert_eq!(normalise("  Costco   whse\t#123 "), "COSTCO WHSE #123");
        assert_eq!(normalise("café\u{a0}ünï"), "CAFé üNï");
    }

    #[test]
    fn a_wildcard_is_whole_string_with_star_and_question_mark() {
        assert!(wildcard_matches("COSTCO*", "COSTCO WHSE #123"));
        assert!(wildcard_matches("*WHSE*", "COSTCO WHSE #123"));
        assert!(wildcard_matches("*", ""));
        assert!(wildcard_matches("A?C", "ABC"));
        assert!(!wildcard_matches("A?C", "AC"));
        assert!(
            !wildcard_matches("COSTCO", "COSTCO WHSE"),
            "the whole string must match"
        );
        assert!(wildcard_matches("A*B*C", "AXXBYYC"));
        assert!(!wildcard_matches("A*B*C", "AXXBYY"));
        assert!(wildcard_matches("**A", "BA"));
        // Characters, not bytes.
        assert!(wildcard_matches("CAF?", "CAFÉ"));
    }

    fn rule(kind: &str, pattern: &str) -> Rule {
        Rule {
            rule_id: "r".to_owned(),
            match_kind: kind.to_owned(),
            pattern: normalise(pattern),
            amount_min_minor: None,
            amount_max_minor: None,
            account_id: None,
            set_category_concept_id: None,
            set_display_name: None,
            position: 0,
        }
    }

    #[test]
    fn specificity_weighs_the_kind_and_each_bound() {
        assert_eq!(rule("contains", "x").specificity(), 1);
        assert_eq!(rule("matches", "x").specificity(), 2);
        assert_eq!(rule("is", "x").specificity(), 3);
        let mut bounded = rule("contains", "x");
        bounded.amount_min_minor = Some(1);
        bounded.amount_max_minor = Some(2);
        bounded.account_id = Some("a".to_owned());
        assert_eq!(bounded.specificity(), 4);
    }

    #[test]
    fn a_rule_matches_text_amount_and_account() {
        let mut bounded = rule("contains", "costco");
        bounded.amount_min_minor = Some(1_000);
        bounded.amount_max_minor = Some(5_000);
        bounded.account_id = Some("a".to_owned());
        let text = normalise("Costco Whse");
        assert!(bounded.matches(&text, 1_000, "a"), "bounds are inclusive");
        assert!(bounded.matches(&text, 5_000, "a"));
        assert!(!bounded.matches(&text, 999, "a"));
        assert!(!bounded.matches(&text, 5_001, "a"));
        assert!(!bounded.matches(&text, 2_000, "b"));
        assert!(rule("is", "costco whse").matches(&text, 1, "a"));
        assert!(!rule("is", "costco").matches(&text, 1, "a"));
    }

    #[test]
    fn dates_and_months_are_real_or_refused() {
        assert!(real_date("2024-02-29"));
        assert!(!real_date("2023-02-29"));
        assert!(!real_date("2023-13-01"));
        assert!(!real_date("2023-04-31"));
        assert!(!real_date("2023-4-01"));
        assert!(real_month("2026-10"));
        assert!(!real_month("2026-00"));
        assert!(!real_month("2026-13"));
    }
}
