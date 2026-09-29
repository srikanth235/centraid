//! THE EXPORT, AS A FILE (#1047).
//!
//! `phone::load_export` answers one group's ledger as rows; this renders those
//! rows as the file a member saves, so a shell formats no money and quotes no
//! field. RFC 4180 CSV — CRLF line ends, a header row, a field quoted exactly
//! when it holds a comma, a quote or a line break, and a quote doubled inside
//! one — because that is what every spreadsheet opens.
//!
//! **An amount is a plain decimal placed by its currency's own exponent**
//! (`42.50`, `4250` for JPY, `4.250` for BHD): never grouped and never
//! localised, since a file is read by a program as often as by a person, and
//! the currency code rides in its own column.

use centraid_apps_kit::money::Money;

use crate::phone::Export;

/// The header row, in the column order every data row follows.
pub const HEADER: [&str; 10] = [
    "kind",
    "date",
    "description",
    "category",
    "amount",
    "currency",
    "paid_by",
    "paid_to",
    "split",
    "your_share",
];

/// The whole file. EMPTY for a group that does not exist: there is nothing to
/// save, and a header over no group would read as a group with no expenses.
#[must_use]
pub fn csv(export: &Export) -> String {
    if export.group.is_none() {
        return String::new();
    }
    let mut out = String::new();
    push_row(&mut out, HEADER.iter().map(|column| (*column).to_owned()));
    for expense in &export.expenses {
        let your_share = expense
            .splits
            .iter()
            .find(|share| share.person.is_me)
            .map(|share| decimal(&share.amount))
            .unwrap_or_default();
        push_row(
            &mut out,
            [
                "expense".to_owned(),
                expense.spent_on.clone(),
                expense.description.clone(),
                expense.category.clone(),
                decimal(&expense.amount),
                expense.amount.currency.code().to_owned(),
                expense.paid_by.name.clone(),
                String::new(),
                expense.split_method.clone(),
                your_share,
            ],
        );
    }
    for settlement in &export.settlements {
        push_row(
            &mut out,
            [
                "settlement".to_owned(),
                settlement.paid_on.clone().unwrap_or_default(),
                String::new(),
                String::new(),
                decimal(&settlement.amount),
                settlement.amount.currency.code().to_owned(),
                settlement.from.name.clone(),
                settlement.to.name.clone(),
                String::new(),
                String::new(),
            ],
        );
    }
    out
}

/// The save sheet's file name: the group's name slugged, the day, `.csv` —
/// `tahoe-trip-2026-09-25.csv`. A name with nothing sluggable is `tally`.
#[must_use]
pub fn file_name(export: &Export, today: &str) -> String {
    let Some(group) = &export.group else {
        return String::new();
    };
    let mut slug = String::new();
    for character in group.name.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            slug.push(character);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "tally" } else { slug };
    if today.is_empty() {
        format!("{slug}.csv")
    } else {
        format!("{slug}-{today}.csv")
    }
}

/// An amount as a plain decimal, placed by the currency's own exponent.
fn decimal(amount: &Money) -> String {
    let exponent = u32::from(amount.currency.minor_units());
    let minor = i128::from(amount.amount_minor);
    let sign = if minor < 0 { "-" } else { "" };
    let magnitude = minor.abs();
    if exponent == 0 {
        return format!("{sign}{magnitude}");
    }
    let divisor = 10_i128.pow(exponent);
    format!(
        "{sign}{}.{:0width$}",
        magnitude / divisor,
        magnitude % divisor,
        width = exponent as usize
    )
}

fn push_row(out: &mut String, fields: impl IntoIterator<Item = String>) {
    let row: Vec<String> = fields.into_iter().map(|field| quoted(&field)).collect();
    out.push_str(&row.join(","));
    out.push_str("\r\n");
}

/// RFC 4180's quoting: only when the field needs it.
fn quoted(field: &str) -> String {
    if field.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::money::money;

    #[test]
    fn an_amount_is_placed_by_its_own_exponent_and_never_grouped() {
        let cases = [
            (425_000, "USD", "4250.00"),
            (4_250, "JPY", "4250"),
            (4_250, "BHD", "4.250"),
            (-5, "USD", "-0.05"),
        ];
        for (minor, code, expected) in cases {
            assert_eq!(decimal(&money(minor, code)), expected, "{code}");
        }
    }

    #[test]
    fn a_field_is_quoted_only_when_it_must_be() {
        assert_eq!(quoted("Gas"), "Gas");
        assert_eq!(quoted("Gas, snacks"), "\"Gas, snacks\"");
        assert_eq!(quoted("the \"good\" cabin"), "\"the \"\"good\"\" cabin\"");
        assert_eq!(quoted("two\nlines"), "\"two\nlines\"");
    }
}
