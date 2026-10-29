//! OFX and QFX, 1.x (SGML) and 2.x (XML), with one tolerant tokeniser.
//!
//! OFX 1.x is SGML: leaf tags are not closed (`<TRNAMT>-4.50`), aggregates are
//! (`</STMTTRN>`), and the file opens with `KEY:VALUE` header lines. OFX 2.x is
//! XML with an `<?xml?>` and `<?OFX?>` prologue and every tag closed. QFX is
//! OFX 1.x with Intuit's `INTU.BID`. No XML crate would read the first, so one
//! scanner reads both: an open tag's value is the text up to the next `<`.
//!
//! **Every `STMTRS` and `CCSTMTRS` is its own statement** (a file may hold
//! several accounts). A statement is matched to an account by the last digits of
//! its `ACCTID` or by the full id stored on the account ([`resolve_account`]);
//! one that matches no account or more than one is refused — never merged
//! silently. A statement whose `CURDEF` is not the account's is refused with the
//! reason.
//!
//! `DTPOSTED` is the **printed day**: its first eight digits, never shifted by
//! the `[-5:EST]` zone. A bad `STMTTRN` is one rejected row.
//!
//! A transaction with no `FITID` gets `ofx-nofitid:<hash>` — the CSV-style hash
//! of day, amount, name and ordinal — so the file still imports, and a repeat of
//! it is still recognised.

use centraid_apps_kit::money::minor_units;

use super::amount::{self, AmountError};
use super::date::{self, Shape};
use super::keys::{Ordinals, nofitid_key};
use super::text;
use super::{
    Checkpoint, Direction, IMPORT_BYTES, IMPORT_ROWS, ImportRow, ParsedRow, Refusal, RejectReason,
    Source, Statement,
};

/// A bank account or a card, by its statement element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountKind {
    Bank,
    Card,
}

/// One `STMTRS` / `CCSTMTRS`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfxStatement {
    pub kind: AccountKind,
    /// `ACCTID` as printed.
    pub acct_id: Option<String>,
    /// `CURDEF`, upper-cased.
    pub currency: Option<String>,
    pub statement: Statement,
}

/// A whole file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfxFile {
    pub statements: Vec<OfxStatement>,
}

/// An account as matching needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRef {
    pub account_id: String,
    pub currency: String,
    /// The full bank-side id, if the member entered it.
    pub external_ref: Option<String>,
    /// The last digits shown (`1234`), if the member entered them.
    pub mask: Option<String>,
}

/// Why one statement of a file is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatementRefusal {
    /// The statement prints no account id.
    NoAccountId,
    /// No account of the member's matches it.
    NoAccount,
    /// More than one account matches it.
    Ambiguous,
    /// The statement prints no currency.
    NoCurrency,
    CurrencyMismatch {
        statement: String,
        account: String,
    },
}

impl StatementRefusal {
    /// The sentence the plan shows. It names the currencies, never the account
    /// id.
    #[must_use]
    pub fn sentence(&self) -> String {
        match self {
            Self::NoAccountId => "This statement does not say which account it is for.".to_owned(),
            Self::NoAccount => "No account matches this statement.".to_owned(),
            Self::Ambiguous => "More than one account matches this statement.".to_owned(),
            Self::NoCurrency => "This statement does not say its currency.".to_owned(),
            Self::CurrencyMismatch { statement, account } => {
                format!("This statement is in {statement}; the account is in {account}.")
            }
        }
    }
}

fn alnum_upper(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// The currency check alone, for a member who picked the account.
///
/// # Errors
/// [`StatementRefusal::NoCurrency`] or [`StatementRefusal::CurrencyMismatch`].
pub fn check_currency(statement: &OfxStatement, currency: &str) -> Result<(), StatementRefusal> {
    match &statement.currency {
        None => Err(StatementRefusal::NoCurrency),
        Some(printed) if !printed.eq_ignore_ascii_case(currency) => {
            Err(StatementRefusal::CurrencyMismatch {
                statement: printed.clone(),
                account: currency.to_ascii_uppercase(),
            })
        }
        Some(_) => Ok(()),
    }
}

/// The one account `statement` belongs to.
///
/// # Errors
/// [`StatementRefusal`]: no id, no match, two matches, or a currency that
/// differs from the account's.
pub fn resolve_account<'a>(
    statement: &OfxStatement,
    accounts: &'a [AccountRef],
) -> Result<&'a AccountRef, StatementRefusal> {
    let id = alnum_upper(statement.acct_id.as_deref().unwrap_or_default());
    if id.is_empty() {
        return Err(StatementRefusal::NoAccountId);
    }
    let mut found: Vec<&AccountRef> = accounts
        .iter()
        .filter(|account| {
            let full = account
                .external_ref
                .as_deref()
                .map(alnum_upper)
                .is_some_and(|reference| !reference.is_empty() && reference == id);
            let last = account
                .mask
                .as_deref()
                .map(alnum_upper)
                .is_some_and(|mask| mask.len() >= 4 && id.ends_with(&mask));
            full || last
        })
        .collect();
    found.dedup_by_key(|account| account.account_id.clone());
    match found.as_slice() {
        [] => Err(StatementRefusal::NoAccount),
        [one] => {
            check_currency(statement, &one.currency)?;
            Ok(one)
        }
        _ => Err(StatementRefusal::Ambiguous),
    }
}

// ---------------------------------------------------------------------------
// Tokeniser.
// ---------------------------------------------------------------------------

enum Event {
    Open {
        name: String,
        value: String,
        line: usize,
    },
    Close {
        name: String,
    },
}

fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let decoded = after.find(';').filter(|&end| end <= 8).and_then(|end| {
            let name = &after[..end];
            let character = match name {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                _ => name.strip_prefix('#').and_then(|number| {
                    let code = match number.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => number.parse().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            };
            character.map(|c| (c, end))
        });
        match decoded {
            Some((character, end)) => {
                out.push(character);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn events(text: &str) -> Vec<Event> {
    let mut out = Vec::new();
    let mut line = 1usize;
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        line += rest[..start].matches('\n').count();
        let tag_line = line;
        let after = &rest[start + 1..];
        let Some(end) = after.find('>') else { break };
        let tag = &after[..end];
        line += tag.matches('\n').count();
        rest = &after[end + 1..];
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let closing = tag.starts_with('/');
        let self_closed = tag.ends_with('/');
        let name = tag
            .trim_start_matches('/')
            .trim_end_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if name.is_empty() {
            continue;
        }
        if closing {
            out.push(Event::Close { name });
            continue;
        }
        let value_end = rest.find('<').unwrap_or(rest.len());
        let value = unescape(rest[..value_end].trim());
        out.push(Event::Open {
            name: name.clone(),
            value,
            line: tag_line,
        });
        if self_closed {
            out.push(Event::Close { name });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RawTxn {
    line: usize,
    fitid: String,
    posted: String,
    amount: String,
    name: String,
    memo: String,
    kind: String,
    check: String,
}

struct Builder {
    kind: AccountKind,
    acct_id: Option<String>,
    currency: Option<String>,
    txns: Vec<RawTxn>,
    balance: Option<String>,
    balance_as_of: Option<String>,
}

impl Builder {
    fn new(kind: AccountKind) -> Self {
        Self {
            kind,
            acct_id: None,
            currency: None,
            txns: Vec::new(),
            balance: None,
            balance_as_of: None,
        }
    }
}

/// The bytes' text: OFX 1.x announces its code page in the header.
fn decode(bytes: &[u8]) -> String {
    let head = &bytes[..bytes.len().min(512)];
    let head = String::from_utf8_lossy(head).to_ascii_uppercase();
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if head.contains("CHARSET:1252") || head.contains("CHARSET: 1252") {
        text::decode_windows_1252(bytes)
    } else {
        text::decode(bytes).0
    }
}

/// Reads an OFX or QFX file.
///
/// # Errors
/// [`Refusal`] for a file over the limits, one that is not OFX, or one with no
/// statement. A bad transaction is a rejected row.
pub fn read_ofx(bytes: &[u8]) -> Result<OfxFile, Refusal> {
    if bytes.len() > IMPORT_BYTES {
        return Err(Refusal::TooLarge {
            bytes: bytes.len(),
            limit: IMPORT_BYTES,
        });
    }
    let text = decode(bytes);
    if text.trim().is_empty() {
        return Err(Refusal::Empty);
    }
    let events = events(&text);
    if !events
        .iter()
        .any(|event| matches!(event, Event::Open { name, .. } if name == "OFX"))
    {
        return Err(Refusal::UnreadableOfx);
    }
    let mut builders: Vec<Builder> = Vec::new();
    let mut txn: Option<RawTxn> = None;
    let (mut in_ledger, mut in_avail, mut in_acct) = (false, false, false);
    let finish_txn = |builders: &mut Vec<Builder>, txn: &mut Option<RawTxn>| {
        if let Some(done) = txn.take() {
            if builders.is_empty() {
                builders.push(Builder::new(AccountKind::Bank));
            }
            if let Some(current) = builders.last_mut() {
                current.txns.push(done);
            }
        }
    };
    for event in events {
        match event {
            Event::Open { name, value, line } => match name.as_str() {
                "STMTRS" | "CCSTMTRS" => {
                    finish_txn(&mut builders, &mut txn);
                    builders.push(Builder::new(if name == "STMTRS" {
                        AccountKind::Bank
                    } else {
                        AccountKind::Card
                    }));
                }
                "STMTTRN" => {
                    finish_txn(&mut builders, &mut txn);
                    txn = Some(RawTxn {
                        line,
                        ..RawTxn::default()
                    });
                }
                "LEDGERBAL" => in_ledger = true,
                "AVAILBAL" => in_avail = true,
                "BANKACCTFROM" | "CCACCTFROM" => in_acct = true,
                leaf => {
                    if let Some(current) = txn.as_mut() {
                        match leaf {
                            "FITID" => current.fitid = value,
                            "DTPOSTED" => current.posted = value,
                            "TRNAMT" => current.amount = value,
                            "NAME" => current.name = value,
                            "MEMO" => current.memo = value,
                            "TRNTYPE" => current.kind = value,
                            "CHECKNUM" => current.check = value,
                            _ => {}
                        }
                    } else if let Some(current) = builders.last_mut() {
                        match leaf {
                            "CURDEF" => current.currency = Some(value.to_ascii_uppercase()),
                            "ACCTID" if in_acct => current.acct_id = Some(value),
                            "BALAMT" if in_ledger && !in_avail => current.balance = Some(value),
                            "DTASOF" if in_ledger && !in_avail => {
                                current.balance_as_of = Some(value);
                            }
                            _ => {}
                        }
                    }
                }
            },
            Event::Close { name } => match name.as_str() {
                "STMTTRN" => finish_txn(&mut builders, &mut txn),
                "LEDGERBAL" => in_ledger = false,
                "AVAILBAL" => in_avail = false,
                "BANKACCTFROM" | "CCACCTFROM" => in_acct = false,
                "STMTRS" | "CCSTMTRS" => finish_txn(&mut builders, &mut txn),
                _ => {}
            },
        }
    }
    finish_txn(&mut builders, &mut txn);
    if builders.is_empty() {
        return Err(Refusal::NotAStatement);
    }
    if builders.iter().map(|b| b.txns.len()).sum::<usize>() > IMPORT_ROWS {
        return Err(Refusal::TooManyRows { limit: IMPORT_ROWS });
    }
    Ok(OfxFile {
        statements: builders.into_iter().map(finish).collect(),
    })
}

fn printed_day(value: &str) -> Option<String> {
    let digits: String = value.trim().chars().take(8).collect();
    if digits.len() != 8 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    match date::shape(&digits) {
        Shape::Ymd(y, m, d) => Some(crate::civil::format(y, m, d)),
        _ => None,
    }
}

fn finish(builder: Builder) -> OfxStatement {
    let exponent = builder.currency.as_deref().map_or(2, minor_units);
    let mut ordinals = Ordinals::default();
    let rows = builder
        .txns
        .iter()
        .map(|raw| ParsedRow {
            line: raw.line,
            result: read_txn(raw, exponent, &mut ordinals),
        })
        .collect();
    let checkpoint = match (&builder.balance, &builder.balance_as_of) {
        (Some(balance), Some(as_of)) => {
            match (amount::parse(balance, exponent), printed_day(as_of)) {
                (Ok(read), Some(as_of)) => Some(Checkpoint {
                    as_of,
                    balance_minor: read.minor,
                }),
                _ => None,
            }
        }
        _ => None,
    };
    OfxStatement {
        kind: builder.kind,
        acct_id: builder.acct_id,
        currency: builder.currency,
        statement: Statement {
            source: Source::Ofx,
            rows,
            checkpoint,
            profile: None,
            question: None,
            warnings: Vec::new(),
        },
    }
}

fn some(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

fn read_txn(
    raw: &RawTxn,
    exponent: u8,
    ordinals: &mut Ordinals,
) -> Result<ImportRow, RejectReason> {
    if raw.posted.is_empty() {
        return Err(RejectReason::MissingDate);
    }
    let posted_on = printed_day(&raw.posted).ok_or(RejectReason::UnreadableDate)?;
    let minor = match amount::parse(&raw.amount, exponent) {
        Ok(read) => read.minor,
        Err(AmountError::Empty) if raw.amount.trim().is_empty() => {
            return Err(RejectReason::MissingAmount);
        }
        Err(AmountError::Empty | AmountError::Unreadable) => {
            return Err(RejectReason::UnreadableAmount);
        }
        Err(AmountError::TooLarge) => return Err(RejectReason::AmountTooLarge),
    };
    if minor == 0 {
        return Err(RejectReason::ZeroAmount);
    }
    let direction = if minor < 0 {
        Direction::Debit
    } else {
        Direction::Credit
    };
    let (description, memo) = if raw.name.is_empty() {
        (raw.memo.clone(), None)
    } else {
        (raw.name.clone(), some(&raw.memo))
    };
    let external_id = if raw.fitid.is_empty() {
        nofitid_key(ordinals, &posted_on, minor, &description)
    } else {
        format!("ofx:{}", raw.fitid)
    };
    Ok(ImportRow {
        external_id,
        posted_on,
        amount_minor: minor.abs(),
        direction,
        description,
        memo,
        check_number: some(&raw.check),
        bank_type: some(&raw.kind),
        category_concept_id: None,
        display_name: None,
    })
}
