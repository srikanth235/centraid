//! RFC 4180 TEXT, shared by every command that answers a spreadsheet file (`txn.export_csv`,
//! `health.export_csv`): a field holding a comma, a quote or a line break is quoted with the
//! quote doubled, and every record ends in CRLF.

/// One cell: words, which a spreadsheet must never run as a formula, or a number the exporter
/// wrote itself, which it must leave as it is.
#[derive(Clone, Copy)]
pub(crate) enum Cell<'a> {
    Text(&'a str),
    Number(&'a str),
}

/// A words cell.
pub(crate) fn words(value: &str) -> Cell<'_> {
    Cell::Text(value)
}

/// A number the exporter spelled (`-12.50`): written as is, never prefixed.
pub(crate) fn number(value: &str) -> Cell<'_> {
    Cell::Number(value)
}

/// One field spelled for CSV: quoted when it holds a comma, a quote or a line break. A words
/// cell that opens with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so
/// Excel and Sheets show it instead of running it (OWASP, CSV injection). This is the one place
/// that rule lives.
pub(crate) fn field(cell: Cell<'_>) -> String {
    let (value, prefix) = match cell {
        Cell::Text(value) => (value, value.starts_with(['=', '+', '-', '@', '\t', '\r'])),
        Cell::Number(value) => (value, false),
    };
    let value = if prefix {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

/// One record: its cells joined by commas, ended by CRLF.
pub(crate) fn row(cells: &[Cell<'_>]) -> String {
    let mut out = cells
        .iter()
        .map(|c| field(*c))
        .collect::<Vec<_>>()
        .join(",");
    out.push_str("\r\n");
    out
}

/// One record of words only (a header).
pub(crate) fn text_row(cells: &[&str]) -> String {
    row(&cells.iter().map(|c| words(c)).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::{field, number, row, text_row, words};

    #[test]
    fn a_field_is_quoted_only_when_it_must_be() {
        assert_eq!(field(words("plain")), "plain");
        assert_eq!(field(words("a,b")), "\"a,b\"");
        assert_eq!(field(words("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(field(words("one\ntwo")), "\"one\ntwo\"");
    }

    #[test]
    fn a_words_cell_that_would_run_as_a_formula_is_written_as_text() {
        for opener in ["=", "+", "-", "@", "\t"] {
            let cell = format!("{opener}SUM(A1)");
            assert_eq!(field(words(&cell)), format!("'{cell}"), "{opener:?}");
        }
        assert_eq!(field(words("\rx")), "\"'\rx\"");
    }

    #[test]
    fn a_number_the_exporter_wrote_is_not_prefixed() {
        assert_eq!(field(number("-12.50")), "-12.50");
        assert_eq!(
            row(&[words("Rent"), number("-1200.00")]),
            "Rent,-1200.00\r\n"
        );
    }

    #[test]
    fn an_ordinary_cell_is_untouched_and_a_formula_cell_can_also_be_quoted() {
        assert_eq!(field(words("Coffee - beans")), "Coffee - beans");
        assert_eq!(field(words("=A1,B1")), "\"'=A1,B1\"");
        assert_eq!(text_row(&["=x", "y"]), "'=x,y\r\n");
    }
}
