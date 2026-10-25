//! Facts about a photograph that more than one of the one-photograph screens
//! words: a byte size, the capture-local date.

use super::cells;
use crate::kit::civil;
use crate::strings::{Locale, fill, photos as words, photos_lightbox as own};

const KB: i64 = 1_000;
const MB: i64 = 1_000_000;
const GB: i64 = 1_000_000_000;

/// `1 byte`, `512 bytes`, `340 KB`, `3.1 MB`, `1.2 GB`: decimal units, tenths
/// rounded half up, a size the vault spells once.
#[must_use]
pub fn bytes_phrase(locale: Locale, count: i64) -> String {
    let size = count.max(0);
    if size < KB {
        return if size == 1 {
            words::photos_byte_one(locale)
        } else {
            fill(
                &words::photos_bytes_many(locale),
                &[("count", &size.to_string())],
            )
        };
    }
    if size < MB {
        return fill(&own::size_kb(locale), &[("n", &(size / KB).to_string())]);
    }
    let tenths = |unit: i64| (size / unit) * 10 + ((size % unit) * 10 + unit / 2) / unit;
    let said = |tenths: i64| format!("{}.{}", tenths / 10, tenths % 10);
    if size < GB {
        let in_mb = tenths(MB);
        if in_mb >= 10_000 {
            return fill(&own::size_gb(locale), &[("n", &said(tenths(GB)))]);
        }
        return fill(&own::size_mb(locale), &[("n", &said(in_mb))]);
    }
    fill(&own::size_gb(locale), &[("n", &said(tenths(GB)))])
}

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
    fn a_size_is_said_in_decimal_units_with_tenths_rounded_half_up() {
        let en = Locale::En;
        assert_eq!(bytes_phrase(en, 0), "0 bytes");
        assert_eq!(bytes_phrase(en, 1), "1 byte");
        assert_eq!(bytes_phrase(en, 999), "999 bytes");
        assert_eq!(bytes_phrase(en, 340_999), "340 KB");
        assert_eq!(bytes_phrase(en, 3_050_000), "3.1 MB");
        assert_eq!(bytes_phrase(en, 999_960_000), "1.0 GB");
        assert_eq!(bytes_phrase(en, 1_240_000_000), "1.2 GB");
        assert_eq!(bytes_phrase(en, -5), "0 bytes");
    }

    #[test]
    fn the_stamp_is_the_capture_local_day_or_nothing() {
        let en = Locale::En;
        assert_eq!(stamp_date(en, "2026-07-30T23:30:00Z", 120), "31 July 2026");
        assert_eq!(stamp_date(en, "", 0), "");
    }
}
