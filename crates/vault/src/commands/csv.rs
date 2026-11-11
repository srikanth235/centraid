//! RFC 4180 TEXT, shared by every command that answers a spreadsheet file (`txn.export_csv`,
//! `health.export_csv`): a field holding a comma, a quote or a line break is quoted with the
//! quote doubled, and every record ends in CRLF.

/// One field spelled for CSV: quoted when it holds a comma, a quote or a line break.
pub(crate) fn field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// One record: its fields joined by commas, ended by CRLF.
pub(crate) fn row(cells: &[&str]) -> String {
    let mut out = cells.iter().map(|c| field(c)).collect::<Vec<_>>().join(",");
    out.push_str("\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::field;

    #[test]
    fn a_field_is_quoted_only_when_it_must_be() {
        assert_eq!(field("plain"), "plain");
        assert_eq!(field("a,b"), "\"a,b\"");
        assert_eq!(field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(field("one\ntwo"), "\"one\ntwo\"");
    }
}
