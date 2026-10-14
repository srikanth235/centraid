//! A bank's CSV, read by its content as much as its header.
//!
//! Banks print no standard: Chase, Amex, Capital One, Bank of America, Wells
//! Fargo, TD, RBC and Tangerine each lay a statement out differently, and a
//! credit card's positive number is a charge where a chequing account's is a
//! deposit. Nothing here knows a bank by name. [`read_csv`] detects, over the
//! **whole file**:
//!
//! - the **delimiter** (`,` `;` tab `|`) by which one makes every row the same
//!   width;
//! - the **header row**, past any preamble (Bank of America's summary lines) —
//!   or none (Wells Fargo, TD);
//! - each **column's role** by header synonym *and* by what the column holds: a
//!   date column parses as dates all the way down, an amount column as amounts;
//! - the **date order** by [`date::decide`]: a day over 12 in either slot settles
//!   it; a file that never does is [`DateOrder::Ask`], and the statement carries
//!   a [`DateOrderQuestion`] instead of rows;
//! - **which way money moved** — four modes ([`AmountSpec`]): a signed amount,
//!   debit and credit columns, an amount plus an indicator column, or a signed
//!   amount read the other way round (a card's charges are positive).
//!
//! The result is a [`CsvProfile`], keyed by a [fingerprint] of the header cells
//! and the column count. A saved profile is re-applied while the fingerprint
//! matches; when the bank changes its columns the file is detected afresh and
//! the statement says so ([`Warning::ProfileChanged`]).
//!
//! [fingerprint]: fingerprint

use std::collections::{BTreeSet, HashMap};

use centraid_apps_kit::csv as kit_csv;
use centraid_apps_kit::money::minor_units;
use serde::{Deserialize, Serialize};

use super::amount::{self, AmountError};
use super::date::{self, DateOrder, Shape};
use super::keys::{Ordinals, csv_key};
use super::text;
use super::{
    Direction, IMPORT_BYTES, IMPORT_ROWS, ImportRow, ParsedRow, Refusal, RejectReason, Source,
    Statement, Warning,
};

/// How a row's direction and magnitude are read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AmountSpec {
    /// One column; negative is money out.
    Signed { amount: usize },
    /// One column; positive is money out (a credit card's charges).
    Flip { amount: usize },
    /// Debit and credit columns (either may be absent); the sign is ignored.
    DebitCredit {
        debit: Option<usize>,
        credit: Option<usize>,
    },
    /// An amount column read as a magnitude and a column that says which way.
    Indicator {
        amount: usize,
        indicator: usize,
        /// The indicator (lower-cased, trimmed) that means money out.
        out_value: String,
        /// The indicator that means money in.
        in_value: String,
    },
}

/// Everything the reader decided about a layout; saved by the caller keyed by
/// account, re-applied while [`CsvProfile::fingerprint`] matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CsvProfile {
    pub fingerprint: String,
    pub delimiter: char,
    /// Records before the header (or before the first data row without one),
    /// counting every record the tokeniser returned, blank lines included.
    pub skip_rows: usize,
    pub has_header: bool,
    pub date: usize,
    pub date_order: DateOrder,
    pub description: usize,
    pub memo: Option<usize>,
    pub check_number: Option<usize>,
    pub bank_type: Option<usize>,
    pub amounts: AmountSpec,
}

/// Which way a single signed column runs, when the member overrides the guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignChoice {
    /// Negative is money out (a chequing account).
    DebitsNegative,
    /// Positive is money out (a credit card).
    DebitsPositive,
}

/// What the caller knows.
#[derive(Debug, Clone, Copy)]
pub struct CsvOptions<'a> {
    /// The account's currency, for the minor-unit exponent and an `CAD$` column.
    pub currency: &'a str,
    /// A saved profile, tried first.
    pub profile: Option<&'a CsvProfile>,
    /// The member's answer to a [`DateOrderQuestion`](super::DateOrderQuestion);
    /// used only where the file could not decide.
    pub date_order: Option<DateOrder>,
    /// The member's override of a guessed sign.
    pub sign: Option<SignChoice>,
}

impl<'a> CsvOptions<'a> {
    #[must_use]
    pub const fn new(currency: &'a str) -> Self {
        Self {
            currency,
            profile: None,
            date_order: None,
            sign: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/// Reads a CSV statement.
///
/// # Errors
/// [`Refusal`] for a file over the limits, an empty one, or one with no date
/// and amount to be found. A bad row is [`ParsedRow`]'s `Err`, not an error.
pub fn read_csv(bytes: &[u8], options: &CsvOptions<'_>) -> Result<Statement, Refusal> {
    if bytes.len() > IMPORT_BYTES {
        return Err(Refusal::TooLarge {
            bytes: bytes.len(),
            limit: IMPORT_BYTES,
        });
    }
    let (text, _) = text::decode(bytes);
    // CRLF and LF exports of one statement must hash alike, a quoted newline
    // included.
    let text = text.replace("\r\n", "\n");
    if text.trim().is_empty() {
        return Err(Refusal::Empty);
    }
    let mut warnings = Vec::new();
    if let Some(saved) = options.profile {
        let records = kit_csv::records(&text, saved.delimiter);
        if fingerprint(&records, saved.skip_rows, saved.has_header).as_deref()
            == Some(saved.fingerprint.as_str())
        {
            return build(&records, saved.clone(), options, warnings);
        }
        warnings.push(Warning::ProfileChanged);
    }
    let delimiter = detect_delimiter(&text);
    let records = kit_csv::records(&text, delimiter);
    let (profile, sign_guessed) = detect_profile(&records, delimiter, options)?;
    if sign_guessed {
        warnings.push(Warning::SignGuessed);
    }
    build(&records, profile, options, warnings)
}

/// A stable hash of the normalised header cells and the column count; for a
/// file with no header, of the column count alone.
#[must_use]
pub fn fingerprint(
    records: &[kit_csv::Record],
    skip_rows: usize,
    has_header: bool,
) -> Option<String> {
    let record = records.get(skip_rows)?;
    let cells = if has_header {
        record
            .cells
            .iter()
            .map(|cell| normalise_header(cell))
            .collect::<Vec<_>>()
            .join("\u{1f}")
    } else {
        String::new()
    };
    let input = format!("{has_header}|{}|{cells}", record.cells.len());
    Some(hex::encode(
        &blake3::hash(input.as_bytes()).as_bytes()[..16],
    ))
}

// ---------------------------------------------------------------------------
// Delimiter.
// ---------------------------------------------------------------------------

/// The delimiter that makes the most rows the same width, over the whole file.
#[must_use]
pub fn detect_delimiter(text: &str) -> char {
    let mut best = (',', 0usize);
    for delimiter in [',', ';', '\t', '|'] {
        let mut widths: HashMap<usize, usize> = HashMap::new();
        for row in kit_csv::rows(text, delimiter) {
            if row.iter().all(|cell| cell.trim().is_empty()) {
                continue;
            }
            *widths.entry(row.len()).or_default() += 1;
        }
        let score = widths
            .iter()
            .filter(|&(&width, _)| width >= 2)
            .map(|(&width, &count)| count * (width - 1))
            .max()
            .unwrap_or(0);
        if score > best.1 {
            best = (delimiter, score);
        }
    }
    best.0
}

// ---------------------------------------------------------------------------
// Headers.
// ---------------------------------------------------------------------------

fn normalise_header(cell: &str) -> String {
    let mut out = String::new();
    for c in cell.trim().chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with(' ') && !out.is_empty() {
            out.push(' ');
        }
    }
    out.trim_end().to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Role {
    Date(u8),
    Amount,
    AmountIn(String),
    Debit,
    Credit,
    Description(u8),
    Description2,
    Memo,
    Check,
    Type(u8),
    Balance,
    Other,
}

fn header_role(raw: &str) -> Role {
    let trimmed = raw.trim();
    if trimmed.len() == 4
        && trimmed.ends_with('$')
        && trimmed[..3].chars().all(|c| c.is_ascii_alphabetic())
    {
        return Role::AmountIn(trimmed[..3].to_ascii_uppercase());
    }
    let n = normalise_header(trimmed);
    let has = |word: &str| n.split(' ').any(|w| w == word);
    let contains = |part: &str| n.contains(part);
    if n.is_empty() || has("account") {
        return Role::Other;
    }
    if n == "description 2" || n == "description2" {
        return Role::Description2;
    }
    if contains("check") || contains("cheque") || has("chq") {
        return Role::Check;
    }
    if contains("balance") || has("bal") {
        return Role::Balance;
    }
    if has("date") {
        if has("due") || has("statement") {
            return Role::Other;
        }
        let rank = if contains("post") {
            3
        } else if contains("trans") || has("effective") || has("booking") || has("value") {
            1
        } else {
            2
        };
        return Role::Date(rank);
    }
    if has("debit") && has("credit") {
        return Role::Type(2);
    }
    if has("debit") || has("debits") || contains("withdraw") || n == "money out" || n == "paid out"
    {
        return Role::Debit;
    }
    if ((has("credit") || has("credits")) && !has("card"))
        || contains("deposit")
        || n == "money in"
        || n == "paid in"
    {
        return Role::Credit;
    }
    if has("amount") || has("amt") {
        return Role::Amount;
    }
    if has("memo") || has("notes") || has("note") || has("reference") || has("ref") {
        return Role::Memo;
    }
    if n == "type" || n.ends_with(" type") || has("indicator") || n == "dr cr" || n == "cr dr" {
        return Role::Type(2);
    }
    if n == "details" || n == "transaction" || n == "trans" {
        return Role::Type(1);
    }
    if has("description")
        || has("payee")
        || has("merchant")
        || has("narrative")
        || has("particulars")
    {
        return Role::Description(3);
    }
    if has("name") {
        return Role::Description(2);
    }
    Role::Other
}

fn is_blank(record: &kit_csv::Record) -> bool {
    record.cells.iter().all(|cell| cell.trim().is_empty())
}

/// The index of the header record among the first 50, if there is one: a row
/// that names a date and an amount (or a debit/credit) and holds no date.
fn find_header(records: &[kit_csv::Record]) -> Option<usize> {
    records.iter().take(50).position(|record| {
        let roles: Vec<Role> = record.cells.iter().map(|cell| header_role(cell)).collect();
        let dated = roles.iter().any(|r| matches!(r, Role::Date(_)));
        let moneyed = roles.iter().any(|r| {
            matches!(
                r,
                Role::Amount | Role::AmountIn(_) | Role::Debit | Role::Credit
            )
        });
        dated
            && moneyed
            && !record
                .cells
                .iter()
                .any(|cell| !matches!(date::shape(cell), Shape::Invalid))
    })
}

// ---------------------------------------------------------------------------
// Column statistics and role assignment.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Column {
    nonblank: usize,
    dates: usize,
    amounts: usize,
    negative: usize,
    positive: usize,
    marked: bool,
    length: usize,
    distinct: BTreeSet<String>,
}

impl Column {
    #[allow(clippy::cast_precision_loss)]
    fn fraction(&self, count: usize) -> f64 {
        if self.nonblank == 0 {
            0.0
        } else {
            count as f64 / self.nonblank as f64
        }
    }

    fn is_dated(&self) -> bool {
        self.fraction(self.dates) >= 0.8
    }

    fn is_numeric(&self) -> bool {
        self.nonblank > 0 && self.fraction(self.amounts) >= 0.9 && !self.is_dated()
    }
}

fn column_stats(data: &[&kit_csv::Record], width: usize, exponent: u8) -> Vec<Column> {
    let mut columns: Vec<Column> = (0..width).map(|_| Column::default()).collect();
    for record in data {
        for (at, cell) in record.cells.iter().enumerate().take(width) {
            let cell = cell.trim();
            if cell.is_empty() {
                continue;
            }
            let column = &mut columns[at];
            column.nonblank += 1;
            column.length += cell.chars().count();
            if column.distinct.len() < 64 {
                column.distinct.insert(cell.to_lowercase());
            }
            if !matches!(date::shape(cell), Shape::Invalid) {
                column.dates += 1;
            }
            if let Ok(read) = amount::parse(cell, exponent) {
                column.amounts += 1;
                column.marked |= read.marked;
                match read.minor.cmp(&0) {
                    std::cmp::Ordering::Less => column.negative += 1,
                    std::cmp::Ordering::Greater => column.positive += 1,
                    std::cmp::Ordering::Equal => {}
                }
            }
        }
    }
    columns
}

const OUT_WORDS: [&str; 10] = [
    "debit",
    "dr",
    "d",
    "withdrawal",
    "wd",
    "out",
    "purchase",
    "sale",
    "charge",
    "debits",
];
const IN_WORDS: [&str; 8] = [
    "credit", "cr", "c", "deposit", "dep", "in", "refund", "credits",
];

/// The out/in pair a two-valued indicator column holds, if it holds one.
fn indicator_values(column: &Column) -> Option<(String, String)> {
    let values: Vec<&String> = column.distinct.iter().collect();
    let out: Vec<&&String> = values
        .iter()
        .filter(|v| OUT_WORDS.contains(&v.as_str()))
        .collect();
    let inn: Vec<&&String> = values
        .iter()
        .filter(|v| IN_WORDS.contains(&v.as_str()))
        .collect();
    match (out.as_slice(), inn.as_slice()) {
        ([out], [inn]) => Some(((**out).clone(), (**inn).clone())),
        _ => None,
    }
}

/// Two numeric columns that are never both filled and between them cover the
/// rows: a debit and a credit.
fn disjoint_pair(data: &[&kit_csv::Record], first: usize, second: usize, exponent: u8) -> bool {
    let filled = |record: &kit_csv::Record, at: usize| {
        record
            .cells
            .get(at)
            .is_some_and(|cell| amount::parse(cell, exponent).is_ok())
    };
    let mut both = 0usize;
    let mut either = 0usize;
    for record in data {
        match (filled(record, first), filled(record, second)) {
            (true, true) => both += 1,
            (true, false) | (false, true) => either += 1,
            (false, false) => {}
        }
    }
    both == 0 && either * 10 >= data.len() * 9
}

fn detect_profile(
    records: &[kit_csv::Record],
    delimiter: char,
    options: &CsvOptions<'_>,
) -> Result<(CsvProfile, bool), Refusal> {
    let exponent = minor_units(options.currency);
    let header_at = find_header(records);
    let skip_rows = header_at.unwrap_or(0);
    let first_data = header_at.map_or(0, |at| at + 1);
    let data: Vec<&kit_csv::Record> = records[first_data.min(records.len())..]
        .iter()
        .filter(|record| !is_blank(record))
        .collect();
    if data.is_empty() {
        return Err(Refusal::Empty);
    }
    let width = data
        .iter()
        .map(|record| record.cells.len())
        .chain(header_at.map(|at| records[at].cells.len()))
        .max()
        .unwrap_or(0);
    if width < 2 {
        return Err(Refusal::NotAStatement);
    }
    let stats = column_stats(&data, width, exponent);
    let roles: Vec<Role> = match header_at {
        Some(at) => (0..width)
            .map(|c| {
                records[at]
                    .cells
                    .get(c)
                    .map_or(Role::Other, |cell| header_role(cell))
            })
            .collect(),
        None => vec![Role::Other; width],
    };
    let mut used = vec![false; width];

    // --- Date: a header's best-ranked dated column, else the first dated one.
    let dated: Vec<usize> = (0..width).filter(|&c| stats[c].is_dated()).collect();
    let date_col = dated
        .iter()
        .copied()
        .filter_map(|c| match roles[c] {
            Role::Date(rank) => Some((rank, c)),
            _ => None,
        })
        .min_by_key(|&(rank, c)| (std::cmp::Reverse(rank), c))
        .map(|(_, c)| c)
        .or_else(|| dated.first().copied())
        .ok_or(Refusal::NotAStatement)?;
    used[date_col] = true;

    // --- Date order over every dated column's cells: they share a format.
    let order = date::decide(data.iter().flat_map(|record| {
        dated
            .iter()
            .filter_map(|&c| record.cells.get(c))
            .map(|cell| date::shape(cell.trim()))
            .collect::<Vec<_>>()
    }));

    // --- Money.
    let valid_amount =
        |c: usize| stats[c].nonblank > 0 && stats[c].fraction(stats[c].amounts) >= 0.8;
    let debit = (0..width).find(|&c| {
        roles[c] == Role::Debit && !used[c] && (valid_amount(c) || stats[c].nonblank == 0)
    });
    let credit = (0..width).find(|&c| {
        roles[c] == Role::Credit && !used[c] && (valid_amount(c) || stats[c].nonblank == 0)
    });
    let mut sign_guessed = false;
    let mut type_cols: Vec<usize> = (0..width)
        .filter(|&c| matches!(roles[c], Role::Type(_)))
        .collect();
    type_cols.sort_by_key(|&c| match roles[c] {
        Role::Type(rank) => (std::cmp::Reverse(rank), c),
        _ => (std::cmp::Reverse(0), c),
    });
    let amounts = if debit.is_some() || credit.is_some() {
        for c in debit.iter().chain(credit.iter()) {
            used[*c] = true;
        }
        AmountSpec::DebitCredit { debit, credit }
    } else {
        // A single amount column: a header's, preferring the account's own
        // currency column (RBC's CAD$ / USD$), else the numeric column with a
        // header-less pair test, else the first numeric one.
        let header_amount = (0..width)
            .filter(|&c| matches!(roles[c], Role::Amount | Role::AmountIn(_)) && valid_amount(c))
            .max_by_key(|&c| {
                let own = matches!(&roles[c], Role::AmountIn(code) if code == &options.currency.to_ascii_uppercase());
                (own, stats[c].nonblank, std::cmp::Reverse(c))
            });
        let numeric: Vec<usize> = (0..width)
            .filter(|&c| {
                stats[c].is_numeric()
                    && !used[c]
                    && !matches!(roles[c], Role::Check | Role::Balance | Role::Date(_))
            })
            .collect();
        let pair = if header_amount.is_none() {
            numeric.iter().enumerate().find_map(|(at, &first)| {
                numeric[at + 1..]
                    .iter()
                    .find(|&&second| disjoint_pair(&data, first, second, exponent))
                    .map(|&second| (first, second))
            })
        } else {
            None
        };
        if let Some((first, second)) = pair {
            used[first] = true;
            used[second] = true;
            AmountSpec::DebitCredit {
                debit: Some(first),
                credit: Some(second),
            }
        } else {
            let amount_col = header_amount
                .or_else(|| numeric.first().copied())
                .ok_or(Refusal::NotAStatement)?;
            used[amount_col] = true;
            let column = &stats[amount_col];
            let has_balance = roles.contains(&Role::Balance);
            let indicator = type_cols
                .iter()
                .find_map(|&c| indicator_values(&stats[c]).map(|(out, inn)| (c, out, inn)));
            match options.sign {
                Some(SignChoice::DebitsNegative) => AmountSpec::Signed { amount: amount_col },
                Some(SignChoice::DebitsPositive) => AmountSpec::Flip { amount: amount_col },
                None if column.marked || (column.negative > 0 && column.positive == 0) => {
                    AmountSpec::Signed { amount: amount_col }
                }
                None if column.negative > 0 => {
                    if column.positive > column.negative {
                        sign_guessed = true;
                        AmountSpec::Flip { amount: amount_col }
                    } else {
                        AmountSpec::Signed { amount: amount_col }
                    }
                }
                None => {
                    if let Some((indicator, out_value, in_value)) = indicator {
                        used[indicator] = true;
                        AmountSpec::Indicator {
                            amount: amount_col,
                            indicator,
                            out_value,
                            in_value,
                        }
                    } else {
                        sign_guessed = true;
                        if has_balance {
                            AmountSpec::Signed { amount: amount_col }
                        } else {
                            AmountSpec::Flip { amount: amount_col }
                        }
                    }
                }
            }
        }
    };

    // --- Description: a header's, else a Type-ish column that is really text,
    // else the longest text column.
    let is_text = |c: usize| {
        !used[c] && !stats[c].is_numeric() && !stats[c].is_dated() && stats[c].nonblank > 0
    };
    let description = (0..width)
        .filter(|&c| is_text(c))
        .filter_map(|c| match roles[c] {
            Role::Description(rank) => Some((rank, c)),
            _ => None,
        })
        .min_by_key(|&(rank, c)| (std::cmp::Reverse(rank), c))
        .map(|(_, c)| c)
        .or_else(|| {
            (0..width)
                .filter(|&c| is_text(c) && !matches!(roles[c], Role::Memo | Role::Check))
                .max_by_key(|&c| (stats[c].length, std::cmp::Reverse(c)))
        })
        .ok_or(Refusal::NotAStatement)?;
    used[description] = true;

    let first_with = |wanted: &dyn Fn(&Role) -> bool| {
        (0..width).find(|&c| wanted(&roles[c]) && !used[c] && stats[c].nonblank > 0)
    };
    let memo =
        first_with(&|r| *r == Role::Memo).or_else(|| first_with(&|r| *r == Role::Description2));
    let check_number = first_with(&|r| *r == Role::Check);
    let bank_type = type_cols
        .iter()
        .copied()
        .find(|&c| !used[c] && stats[c].nonblank > 0);

    let mut profile = CsvProfile {
        fingerprint: String::new(),
        delimiter,
        skip_rows,
        has_header: header_at.is_some(),
        date: date_col,
        date_order: order,
        description,
        memo,
        check_number,
        bank_type,
        amounts,
    };
    profile.fingerprint = fingerprint(records, skip_rows, profile.has_header).unwrap_or_default();
    Ok((profile, sign_guessed))
}

// ---------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------

fn build(
    records: &[kit_csv::Record],
    mut profile: CsvProfile,
    options: &CsvOptions<'_>,
    warnings: Vec<Warning>,
) -> Result<Statement, Refusal> {
    let first_data = profile.skip_rows + usize::from(profile.has_header);
    let data: Vec<&kit_csv::Record> = records
        .get(first_data..)
        .unwrap_or_default()
        .iter()
        .filter(|record| !is_blank(record))
        .collect();
    if data.is_empty() {
        return Err(Refusal::Empty);
    }
    if data.len() > IMPORT_ROWS {
        return Err(Refusal::TooManyRows { limit: IMPORT_ROWS });
    }
    // A saved profile that says Ask, or a detection that could not decide, is
    // settled by the member's answer or it is the question.
    if profile.date_order == DateOrder::Ask {
        match options.date_order {
            Some(answer @ (DateOrder::Mdy | DateOrder::Dmy)) => profile.date_order = answer,
            _ => {
                let mut samples = Vec::new();
                for record in &data {
                    let cell = record.cells.get(profile.date).map_or("", |c| c.trim());
                    if matches!(date::shape(cell), Shape::Numeric { .. })
                        && !samples.iter().any(|s| s == cell)
                    {
                        samples.push(cell.to_owned());
                    }
                    if samples.len() == 5 {
                        break;
                    }
                }
                return Ok(Statement {
                    source: Source::Csv,
                    rows: Vec::new(),
                    checkpoint: None,
                    profile: Some(profile),
                    question: Some(super::DateOrderQuestion {
                        samples,
                        options: vec![DateOrder::Mdy, DateOrder::Dmy],
                    }),
                    warnings,
                });
            }
        }
    }
    let exponent = minor_units(options.currency);
    let mut ordinals = Ordinals::default();
    let rows = data
        .iter()
        .map(|record| ParsedRow {
            line: record.line,
            result: read_row(record, &profile, exponent, &mut ordinals),
        })
        .collect();
    Ok(Statement {
        source: Source::Csv,
        rows,
        checkpoint: None,
        profile: Some(profile),
        question: None,
        warnings,
    })
}

fn nonempty(cell: Option<&String>) -> Option<String> {
    cell.map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .map(str::to_owned)
}

fn money_cell(cell: &str, exponent: u8) -> Result<i64, RejectReason> {
    match amount::parse(cell, exponent) {
        Ok(read) => Ok(read.minor),
        Err(AmountError::Empty) if cell.trim().is_empty() => Err(RejectReason::MissingAmount),
        Err(AmountError::Empty | AmountError::Unreadable) => Err(RejectReason::UnreadableAmount),
        Err(AmountError::TooLarge) => Err(RejectReason::AmountTooLarge),
    }
}

fn read_row(
    record: &kit_csv::Record,
    profile: &CsvProfile,
    exponent: u8,
    ordinals: &mut Ordinals,
) -> Result<ImportRow, RejectReason> {
    let cell = |at: usize| record.cells.get(at).map_or("", |c| c.trim());
    let printed = cell(profile.date);
    if printed.is_empty() {
        return Err(RejectReason::MissingDate);
    }
    let posted_on = date::resolve(date::shape(printed), profile.date_order)
        .ok_or(RejectReason::UnreadableDate)?;
    let (direction, magnitude) = match &profile.amounts {
        AmountSpec::Signed { amount } => signed(money_cell(cell(*amount), exponent)?, false)?,
        AmountSpec::Flip { amount } => signed(money_cell(cell(*amount), exponent)?, true)?,
        AmountSpec::DebitCredit { debit, credit } => {
            let read = |column: &Option<usize>| match column.map(&cell) {
                Some(text) if !text.is_empty() => money_cell(text, exponent).map(Some),
                _ => Ok(None),
            };
            let out = read(debit)?;
            let into = read(credit)?;
            match (out.map(i64::abs), into.map(i64::abs)) {
                (Some(d), Some(c)) if d != 0 && c != 0 => {
                    return Err(RejectReason::BothDebitAndCredit);
                }
                (Some(d), _) if d != 0 => (Direction::Debit, d),
                (_, Some(c)) if c != 0 => (Direction::Credit, c),
                (None, None) => return Err(RejectReason::MissingAmount),
                _ => return Err(RejectReason::ZeroAmount),
            }
        }
        AmountSpec::Indicator {
            amount,
            indicator,
            out_value,
            in_value,
        } => {
            let magnitude = money_cell(cell(*amount), exponent)?.abs();
            if magnitude == 0 {
                return Err(RejectReason::ZeroAmount);
            }
            let marker = cell(*indicator).to_lowercase();
            let direction = if &marker == out_value {
                Direction::Debit
            } else if &marker == in_value {
                Direction::Credit
            } else {
                return Err(RejectReason::UnknownIndicator);
            };
            (direction, magnitude)
        }
    };
    let description = cell(profile.description).to_owned();
    let external_id = csv_key(
        ordinals,
        &posted_on,
        direction.signed(magnitude),
        &description,
    );
    Ok(ImportRow {
        external_id,
        posted_on,
        amount_minor: magnitude,
        direction,
        description,
        memo: profile.memo.and_then(|at| nonempty(record.cells.get(at))),
        check_number: profile
            .check_number
            .and_then(|at| nonempty(record.cells.get(at))),
        bank_type: profile
            .bank_type
            .and_then(|at| nonempty(record.cells.get(at))),
        category_concept_id: None,
        display_name: None,
    })
}

fn signed(minor: i64, flip: bool) -> Result<(Direction, i64), RejectReason> {
    if minor == 0 {
        return Err(RejectReason::ZeroAmount);
    }
    let out = (minor < 0) != flip;
    Ok((
        if out {
            Direction::Debit
        } else {
            Direction::Credit
        },
        minor.abs(),
    ))
}
