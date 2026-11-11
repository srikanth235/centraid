//! MONEY AS A SPREADSHEET FILE (#1185): `txn.export_csv`, the transactions of every account, of
//! one account, or one transaction (what a transaction page shares) as one CSV file (RFC 4180).
//! Writes nothing.
//!
//! One row per transaction, newest last as the statement reads: the day, the account, the
//! payee (the member's name for the line, else the bank's words), the bank's own words, the
//! category, the amount as a plain decimal with its currency code in the next column (money out
//! is negative), the status, the bank's memo and the check number. Lines in the trash, and the
//! lines of a trashed account, are not in it. Fields holding a comma, a quote or a line break
//! are quoted with the quote doubled; lines end in CRLF; the text is UTF-8.

use rusqlite::Connection;
use serde_json::Value as Json;

use crate::commands::csv::row;
use crate::commands::{CommandCtx, CommandDefinition, Idempotency, note};
use crate::error::Result;

/// The header row.
const HEADER: [&str; 10] = [
    "Date",
    "Account",
    "Payee",
    "Description",
    "Category",
    "Amount",
    "Currency",
    "Status",
    "Memo",
    "Check number",
];

/// One transaction as the file reads it.
struct Line {
    day: String,
    account: String,
    payee: String,
    bank: String,
    category: String,
    amount_minor: i64,
    currency: String,
    status: String,
    memo: String,
    check_number: String,
}

/// The ISO 4217 minor-unit exponent of the codes the product reaches (two unless listed).
fn exponent(currency: &str) -> u32 {
    match currency {
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX"
        | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        "CLF" | "UYW" => 4,
        _ => 2,
    }
}

/// Minor units as a plain decimal, whole-number arithmetic only: `-1234` in two places is
/// `-12.34`, `5` is `0.05`.
fn decimal(minor: i64, currency: &str) -> String {
    let places = exponent(currency);
    let sign = if minor < 0 { "-" } else { "" };
    let magnitude = minor.unsigned_abs();
    if places == 0 {
        return format!("{sign}{magnitude}");
    }
    let scale = 10_u64.pow(places);
    format!(
        "{sign}{}.{:0width$}",
        magnitude / scale,
        magnitude % scale,
        width = places as usize
    )
}

fn lines(connection: &Connection, account: Option<&str>, one: Option<&str>) -> Result<Vec<Line>> {
    let mut statement = connection.prepare_cached(
        "SELECT t.posted_on, a.title, e.title,
                (SELECT json_extract(s.stated, '$.title') FROM source s
                  WHERE s.entity_id = t.id ORDER BY s.seen_at DESC, s.id LIMIT 1),
                c.title, t.amount_minor, t.currency, t.status,
                (SELECT json_extract(s.stated, '$.line.memo') FROM source s
                  WHERE s.entity_id = t.id ORDER BY s.seen_at DESC, s.id LIMIT 1),
                (SELECT json_extract(s.stated, '$.line.check_number') FROM source s
                  WHERE s.entity_id = t.id ORDER BY s.seen_at DESC, s.id LIMIT 1)
           FROM txn t
           JOIN entity e ON e.id = t.id
           JOIN entity a ON a.id = t.account_id
           LEFT JOIN entity c ON c.id = t.category_id
          WHERE e.deleted_at IS NULL AND a.deleted_at IS NULL
            AND (?1 IS NULL OR t.account_id = ?1)
            AND (?2 IS NULL OR t.id = ?2)
          ORDER BY t.posted_on, e.n",
    )?;
    let rows = statement
        .query_map(rusqlite::params![account, one], |row| {
            // A stated cell may be text or a number (a check number): read it as text.
            let said = |index: usize| -> rusqlite::Result<String> {
                Ok(match row.get::<_, rusqlite::types::Value>(index)? {
                    rusqlite::types::Value::Text(text) => text,
                    rusqlite::types::Value::Integer(n) => n.to_string(),
                    rusqlite::types::Value::Real(n) => n.to_string(),
                    _ => String::new(),
                })
            };
            let payee: String = row.get(2)?;
            let bank = said(3)?;
            Ok(Line {
                day: row.get(0)?,
                account: row.get(1)?,
                bank: if bank.is_empty() { payee.clone() } else { bank },
                payee,
                category: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                amount_minor: row.get(5)?,
                currency: row.get(6)?,
                status: row.get(7)?,
                memo: said(8)?,
                check_number: said(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn file(rows: &[Line]) -> String {
    let mut text = row(&HEADER);
    for line in rows {
        text.push_str(&row(&[
            &line.day,
            &line.account,
            &line.payee,
            &line.bank,
            &line.category,
            &decimal(line.amount_minor, &line.currency),
            &line.currency,
            &line.status,
            &line.memo,
            &line.check_number,
        ]));
    }
    text
}

/// `txn.export_csv`: every account's transactions, one account's (`account_id`), or one
/// transaction (`transaction_id`, what a transaction page shares) as a spreadsheet file. Writes
/// nothing.
fn export_csv(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let account = ctx.optional_str("account_id");
    let one = ctx.optional_str("transaction_id");
    let rows = lines(ctx.connection(), account, one)?;
    let name = if let (Some(_), Some(first)) = (one, rows.first()) {
        format!("{} {}", note::portable_stem(&first.payee), first.day)
    } else if let Some(id) = account {
        let title: Option<String> = ctx
            .connection()
            .query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .ok();
        title.map_or_else(
            || "Transactions".to_owned(),
            |t| format!("{} transactions", note::portable_stem(&t)),
        )
    } else {
        "Transactions".to_owned()
    };
    Ok(serde_json::json!({
        "name": format!("{name}.csv"),
        "media_type": "text/csv",
        "count": rows.len(),
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, file(&rows)),
    }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "txn.export_csv",
        "txn",
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "account_id": { "type": ["string", "null"] },
            "transaction_id": { "type": ["string", "null"] }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        export_csv,
    )]
}

#[cfg(test)]
mod tests {
    use super::decimal;

    #[test]
    fn amounts_are_plain_decimals_in_the_currencys_own_places() {
        assert_eq!(decimal(-1234, "USD"), "-12.34");
        assert_eq!(decimal(5, "USD"), "0.05");
        assert_eq!(decimal(-5, "EUR"), "-0.05");
        assert_eq!(decimal(1200, "JPY"), "1200");
        assert_eq!(decimal(-1234, "KWD"), "-1.234");
        assert_eq!(decimal(i64::MIN, "USD"), "-92233720368547758.08");
    }
}
