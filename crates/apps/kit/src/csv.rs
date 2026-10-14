//! RFC 4180, READ ONCE (#1099, lifted from Locker's `transfer.rs`).
//!
//! One tokeniser, two consumers: Locker's password-manager import and Money's
//! statement import. It is delimiter-parametric because a bank's "CSV" is
//! sometimes `;`, a tab or `|`. Quoted cells, doubled quotes, CRLF or LF, and a
//! newline inside quotes kept. A quote opens a quoted cell only at the start of
//! a cell; a stray quote in the middle of a bare cell is a character.
//!
//! The reader is total: it never errors and never panics on any `&str`, and the
//! caller bounds the input (bytes and rows) BEFORE it calls in.

/// One record and the 1-based line it started on (a quoted newline makes a
/// record span lines, so a record's index is not its line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    /// The line the record's first character sits on, counting from 1.
    pub line: usize,
    pub cells: Vec<String>,
}

/// The comma-delimited rows of `text`.
#[must_use]
pub fn csv_rows(text: &str) -> Vec<Vec<String>> {
    rows(text, ',')
}

/// The rows of `text` split on `delimiter`.
#[must_use]
pub fn rows(text: &str, delimiter: char) -> Vec<Vec<String>> {
    records(text, delimiter)
        .into_iter()
        .map(|record| record.cells)
        .collect()
}

/// The records of `text` split on `delimiter`, each with its starting line.
#[must_use]
pub fn records(text: &str, delimiter: char) -> Vec<Record> {
    let mut out = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut line = 1usize;
    let mut start = 1usize;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\n' {
            line += 1;
        }
        if quoted {
            match character {
                '"' if chars.peek() == Some(&'"') => {
                    cell.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                other => cell.push(other),
            }
            continue;
        }
        match character {
            '"' if cell.is_empty() => quoted = true,
            c if c == delimiter => row.push(std::mem::take(&mut cell)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut cell));
                out.push(Record {
                    line: start,
                    cells: std::mem::take(&mut row),
                });
                start = line;
            }
            other => cell.push(other),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        out.push(Record {
            line: start,
            cells: row,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|c| (*c).to_owned()).collect()
    }

    #[test]
    fn quoted_cells_doubled_quotes_and_crlf() {
        let text = "a,b\r\n\"A, \"\"q\"\" title\",\"two\nlines\"\r\n";
        assert_eq!(
            csv_rows(text),
            vec![s(&["a", "b"]), s(&["A, \"q\" title", "two\nlines"])]
        );
    }

    #[test]
    fn other_delimiters_read_and_comma_is_then_a_character() {
        assert_eq!(rows("a;b,c;d\n", ';'), vec![s(&["a", "b,c", "d"])]);
        assert_eq!(rows("a\tb\n", '\t'), vec![s(&["a", "b"])]);
        assert_eq!(rows("a|\"b|c\"\n", '|'), vec![s(&["a", "b|c"])]);
    }

    #[test]
    fn a_record_knows_its_line_across_a_quoted_newline() {
        let found = records("h\n\"x\ny\",1\nz,2\n", ',');
        assert_eq!(
            found.iter().map(|r| r.line).collect::<Vec<_>>(),
            vec![1, 2, 4]
        );
    }

    #[test]
    fn no_trailing_newline_still_closes_the_last_row_and_empty_is_empty() {
        assert_eq!(csv_rows("a,b"), vec![s(&["a", "b"])]);
        assert!(csv_rows("").is_empty());
        assert_eq!(csv_rows("a,\n"), vec![s(&["a", ""])]);
    }

    #[test]
    fn a_stray_quote_inside_a_bare_cell_is_a_character() {
        assert_eq!(csv_rows("5\" pipe,x\n"), vec![s(&["5\" pipe", "x"])]);
    }
}
