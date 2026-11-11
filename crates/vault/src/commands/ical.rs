//! ICALENDAR TEXT (RFC 5545), the one writer Calendar's events and Reminders' tasks share
//! (#1185): content lines with CRLF endings, 75-octet folding, text escaping and the date forms.
//!
//! Pure functions. `event.export_ics` and `task.export_ics` own what reaches the vault; this
//! module only spells what they were given. Nothing reads iCalendar yet, so there is no parser
//! to round-trip against: the tests here read the output back the way a calendar app does
//! (unfold, split, unescape).

use crate::time::recurrence::parse_instant_ms;
use crate::time::zone::{WallTime, wall_from_epoch};

/// The product line every file carries.
const PRODID: &str = "-//Centraid//Calendar//EN";

/// Longest content line, in octets, before the CRLF.
const LINE_OCTETS: usize = 75;

/// Text as a TEXT value: backslash, semicolon and comma are escaped, a line break is `\n`.
#[must_use]
pub fn escape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            other => out.push(other),
        }
    }
    out
}

/// One content line folded at 75 octets (a continuation starts with one space, which counts),
/// never inside a character, ending in CRLF.
#[must_use]
pub fn fold(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + 8);
    let mut used = 0;
    for c in line.chars() {
        let width = c.len_utf8();
        if used + width > LINE_OCTETS {
            out.push_str("\r\n ");
            used = 1;
        }
        out.push(c);
        used += width;
    }
    out.push_str("\r\n");
    out
}

/// A file being written: lines are pushed already spelled, and each is folded.
#[derive(Debug, Default)]
pub struct Writer {
    text: String,
}

impl Writer {
    /// A file opened as a VCALENDAR.
    #[must_use]
    pub fn calendar() -> Self {
        let mut writer = Self::default();
        writer.line("BEGIN:VCALENDAR");
        writer.line("VERSION:2.0");
        writer.line(&format!("PRODID:{PRODID}"));
        writer.line("CALSCALE:GREGORIAN");
        writer
    }

    /// One content line, spelled by the caller (name, parameters and an already-escaped value).
    pub fn line(&mut self, line: &str) {
        self.text.push_str(&fold(line));
    }

    /// `NAME:value` with the value escaped as text.
    pub fn text(&mut self, name: &str, value: &str) {
        self.line(&format!("{name}:{}", escape_text(value)));
    }

    /// The closed file.
    #[must_use]
    pub fn finish(mut self) -> String {
        self.line("END:VCALENDAR");
        self.text
    }
}

/// `YYYYMMDD` of a stored date or date-time (`2026-03-01`, `2026-03-01T09:00`), or `None`.
#[must_use]
pub fn compact_date(value: &str) -> Option<String> {
    let day = value.get(..10)?;
    let bytes = day.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    Some(format!("{}{}{}", &day[..4], &day[5..7], &day[8..10]))
}

/// `YYYYMMDDTHHMMSS` of a wall clock.
#[must_use]
pub fn compact_wall(wall: WallTime) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}",
        wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second
    )
}

/// `YYYYMMDDTHHMMSSZ` of an instant's milliseconds.
#[must_use]
pub fn compact_utc_ms(millis: i64) -> String {
    format!("{}Z", compact_wall(wall_from_epoch(millis)))
}

/// `YYYYMMDDTHHMMSSZ` of a stored instant (`…Z`, or with an offset).
#[must_use]
pub fn compact_utc(value: &str) -> Option<String> {
    parse_instant_ms(value).map(compact_utc_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unfold(text: &str) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        for raw in text.split("\r\n").filter(|l| !l.is_empty()) {
            match raw.strip_prefix(' ') {
                Some(rest) => lines.last_mut().expect("a line before").push_str(rest),
                None => lines.push(raw.to_owned()),
            }
        }
        lines
    }

    #[test]
    fn text_is_escaped_the_way_calendar_apps_read_it_back() {
        assert_eq!(escape_text("a,b;c\\d\ne\r"), "a\\,b\\;c\\\\d\\ne");
    }

    #[test]
    fn a_long_line_folds_at_75_octets_without_cutting_a_character() {
        let long = format!("SUMMARY:{}", "é".repeat(100));
        let folded = fold(&long);
        assert!(folded.ends_with("\r\n"));
        for physical in folded.split("\r\n").filter(|l| !l.is_empty()) {
            assert!(physical.len() <= LINE_OCTETS, "{} octets", physical.len());
        }
        assert_eq!(unfold(&folded), [long]);
        assert_eq!(fold("SHORT:1"), "SHORT:1\r\n");
    }

    #[test]
    fn dates_are_spelled_compactly() {
        assert_eq!(
            compact_date("2026-03-01T09:00").as_deref(),
            Some("20260301")
        );
        assert_eq!(compact_date("nope"), None);
        assert_eq!(
            compact_utc("2026-03-01T09:00:00.000Z").as_deref(),
            Some("20260301T090000Z")
        );
        assert_eq!(
            compact_utc("2026-03-01T10:00:00+01:00").as_deref(),
            Some("20260301T090000Z")
        );
    }

    #[test]
    fn a_file_is_a_closed_vcalendar_with_crlf_endings() {
        let mut writer = Writer::calendar();
        writer.text("X-NOTE", "a,b");
        let text = writer.finish();
        assert!(text.starts_with("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
        assert!(text.contains("X-NOTE:a\\,b\r\n"));
        assert!(text.ends_with("END:VCALENDAR\r\n"));
        assert!(!text.replace("\r\n", "").contains('\n'));
    }
}
