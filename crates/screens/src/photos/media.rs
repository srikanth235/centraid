//! Facts about a photograph that more than one of the one-photograph screens
//! words: the capture-local date.

use super::cells;
use crate::kit::civil;
use crate::strings::Locale;

/// `30 July 2026` in the capture's own zone; empty when there is no capture time.
#[must_use]
pub fn stamp_date(locale: Locale, taken_at: &str, offset_minutes: i64) -> String {
    let day = cells::capture_day(taken_at, offset_minutes);
    if day.is_empty() {
        return String::new();
    }
    let Some(dom) = civil::day_of_month_of(&day) else {
        return String::new();
    };
    let year = day.get(0..4).unwrap_or_default();
    format!("{dom} {} {year}", civil::month_of(locale, &day))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stamp_is_the_capture_local_day_or_nothing() {
        let en = Locale::En;
        assert_eq!(stamp_date(en, "2026-07-30T23:30:00Z", 120), "31 July 2026");
        assert_eq!(stamp_date(en, "", 0), "");
    }
}
