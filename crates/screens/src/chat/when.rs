//! `5 min ago`, `Yesterday`, `12 September`: how long ago a chat moved.

use crate::kit::civil;
use crate::strings::{Locale, chat as words, shared};

const MINUTE: i64 = 60_000;
const DAY: i64 = 86_400_000;

/// The device clock, epoch milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

/// Empty when either clock is unknown.
pub fn ago(locale: Locale, updated_ms: i64, now: i64) -> String {
    if now <= 0 || updated_ms <= 0 {
        return String::new();
    }
    let minutes = ((now - updated_ms) / MINUTE).max(0);
    let count = u64::try_from(minutes).unwrap_or(0);
    match minutes {
        0 => words::ago_just_now(locale),
        1..=59 => words::ago_minutes(locale, count),
        60..=1439 => words::ago_hours(locale, count / 60),
        1440..=2879 => shared::yesterday(locale),
        2880..=10079 => words::ago_days(locale, count / 1440),
        // The day an old chat last moved is a landmark and not a timestamp: UTC, no zone to say.
        _ => {
            let day = civil::civil_day_of(updated_ms.div_euclid(DAY));
            let month = day.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
            format!(
                "{} {}",
                civil::day_of_month_of(&day).unwrap_or(1),
                civil::month_name(locale, month)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_moved_a_while_ago_is_said_the_way_the_drawer_says_it() {
        let now = 1_700_000_000_000;
        let say = |minutes: i64| ago(Locale::En, now - minutes * MINUTE, now);
        assert_eq!(say(0), "Just now");
        assert_eq!(say(5), "5 min ago");
        assert_eq!(say(61), "1 hr ago");
        assert_eq!(say(26 * 60), "Yesterday");
        assert_eq!(say(3 * 24 * 60), "3 days ago");
        assert_eq!(ago(Locale::En, 0, now), "");
        assert_eq!(ago(Locale::En, now, 0), "");
        // 2023-09-12 in UTC, a landmark
        assert_eq!(ago(Locale::En, 1_694_476_800_000, now), "12 September");
    }
}
