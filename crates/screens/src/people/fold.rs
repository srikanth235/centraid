//! PEOPLE'S WORDS, composed once: every sentence a People view draws is built
//! here from [`crate::strings::people`], so the three screens say one thing one
//! way. Pure, and no clock: every day is the core's (`today`, `in_days`,
//! `*_local_day`), and every piece of day arithmetic is [`crate::kit::civil`]'s.

use centraid_api_proto::core_v1 as wire;

use crate::kit::civil;
use crate::strings::{Locale, people as words, shared};

/// A person's initials: one letter for one word, first and last for more
/// (v0's rule). "?" for a name that is only spaces.
#[must_use]
pub fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let first = |word: &str| word.chars().next().map(|c| c.to_uppercase().to_string());
    match words.as_slice() {
        [] => "?".to_owned(),
        [only] => first(only).unwrap_or_default(),
        [head, .., last] => format!(
            "{}{}",
            first(head).unwrap_or_default(),
            first(last).unwrap_or_default()
        ),
    }
}

/// A wheel key as the theme's colour role: `rose` → `cRose`.
fn hue_role(key: &str) -> String {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => format!("c{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

/// An avatar, finished. A person's hue is drawn from their id; nothing stores
/// a colour of their own (#1135).
#[must_use]
pub fn avatar(party_id: &str, name: &str) -> wire::PeopleAvatar {
    wire::PeopleAvatar {
        initials: initials(name),
        hue_key: hue_role(centraid_design::identity_hue_key(party_id)),
    }
}

/// "Last touch 12 days ago" / "No touch logged yet", in the member's days.
///
/// ONE CIVIL-TIME PATH (#1047): the civil day the core read `last_contacted_at`
/// on in the request's zone, counted against the answer's `today` with
/// [`civil::epoch_day_of`], never an elapsed-time slice of the instant. An
/// answer with no local day (no zone resolved) keeps the core's own
/// `days_since_contact`.
#[must_use]
pub fn last_touch(
    locale: Locale,
    ever_contacted: bool,
    last_local_day: &str,
    today: &str,
    core_days: i64,
) -> String {
    let ever = ever_contacted || !last_local_day.is_empty();
    let days = match (civil::epoch_day_of(last_local_day), civil::epoch_day_of(today)) {
        (Some(from), Some(to)) => to - from,
        _ => core_days,
    };
    match () {
        () if !ever => words::meta_never(locale),
        () if days <= 0 => words::meta_today(locale),
        () if days == 1 => words::meta_yesterday(locale),
        () => words::meta_days(locale, days.unsigned_abs()),
    }
}

/// "Every 14 days" / "No cadence". 0 is no cadence.
#[must_use]
pub fn cadence(locale: Locale, days: i64) -> String {
    match days {
        d if d <= 0 => words::cadence_none(locale),
        1 => words::cadence_every_one(locale),
        d => words::cadence_every(locale, d.unsigned_abs()),
    }
}

/// "Today" / "Tomorrow" / "In 12 days", from the core's `in_days`.
#[must_use]
pub fn in_days(locale: Locale, days: i64) -> String {
    match days {
        d if d <= 0 => shared::today(locale),
        1 => shared::tomorrow(locale),
        d => words::in_days(locale, d.unsigned_abs()),
    }
}

/// "14 August" from `MM-DD`, or the input when it is not one.
#[must_use]
pub fn month_day(locale: Locale, month_day: &str) -> String {
    let Some((month, day)) = month_day.split_once('-') else {
        return month_day.to_owned();
    };
    let (Ok(month), Ok(day)) = (month.parse::<u32>(), day.parse::<u32>()) else {
        return month_day.to_owned();
    };
    let name = civil::month_name(locale, month);
    if name.is_empty() {
        return month_day.to_owned();
    }
    format!("{day} {name}")
}

/// THE DAY A DATE FALLS ON NEXT, "28 February": `today + in_days`, the core's
/// own clamped answer, in words. A 29 February birthday is the 28th in a common
/// year because the core says it is that many days away; the stored `MM-DD`
/// would say the 29th, a day that year does not have. A date the core could not
/// place (`in_days` absent) is the stored day in words.
#[must_use]
pub fn day_label(locale: Locale, today: &str, in_days: Option<i64>, stored: &str) -> String {
    let next = in_days.and_then(|days| civil::plus_days(today, days));
    match next.as_deref() {
        Some(day) => {
            let dom = civil::day_of_month_of(day).unwrap_or_default();
            format!("{dom} {}", civil::month_of(locale, day))
        }
        None => month_day(locale, stored),
    }
}

/// IS THIS A REAL `MM-DD`? The command only checks the pattern, so v0 took `13-45`
/// (audit defect). 29 February is a real annual date.
#[must_use]
pub fn valid_month_day(text: &str) -> bool {
    super::contacts::is_month_day(text)
}

/// A logged instant's day in words, from the civil day the core read it on in the
/// request's zone (`occurred_local_day`, `created_local_day`) against the core's
/// `today`. Empty when the core answered no day.
#[must_use]
pub fn when_logged(locale: Locale, local_day: &str, today: &str) -> String {
    let Some(day) = local_day.get(..10) else {
        return String::new();
    };
    if today.is_empty() {
        civil::day_month(locale, day)
    } else {
        civil::relative_day(locale, day, today)
    }
}

/// BOTH SPELLINGS OF A TOUCH KIND land on one noun (v0's table): the word this
/// phone writes and the notation another writer stored. An unknown value is
/// shown as itself — a value the vault holds is a fact.
#[must_use]
pub fn touch_kind(locale: Locale, kind: &str) -> String {
    match kind.trim().to_lowercase().as_str() {
        "message" => words::kind_message(locale),
        "call" => words::kind_call(locale),
        "visit" | "met up" | "met-up" | "met_up" => words::kind_met_up(locale),
        "note" => words::kind_note(locale),
        "" | "touch" | "interaction" => words::kind_touch(locale),
        _ => upper_first(kind),
    }
}

fn upper_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

/// The touch kinds the Log sheet offers, as the vault stores them, with their
/// labels.
#[must_use]
pub fn log_kinds(locale: Locale) -> Vec<(&'static str, String)> {
    vec![
        ("message", words::kind_message(locale)),
        ("call", words::kind_call(locale)),
        ("met up", words::kind_met_up(locale)),
        ("note", words::kind_note(locale)),
    ]
}

/// The channel kinds `save-contact-channel` offers, with their labels.
#[must_use]
pub fn channel_kinds(locale: Locale) -> Vec<(&'static str, String)> {
    vec![
        ("phone", words::channel_phone(locale)),
        ("email", words::channel_email(locale)),
        ("address", words::channel_address(locale)),
        ("handle", words::channel_handle(locale)),
    ]
}

/// "Phone" for `phone`; an unknown kind is shown as itself.
#[must_use]
pub fn channel_kind(locale: Locale, kind: &str) -> String {
    channel_kinds(locale)
        .into_iter()
        .find(|(key, _)| *key == kind)
        .map_or_else(|| upper_first(kind), |(_, label)| label)
}

/// What a tap on a channel does.
#[must_use]
pub fn channel_intent(kind: &str) -> wire::PeopleChannelIntent {
    match kind {
        "phone" => wire::PeopleChannelIntent::Call,
        "email" => wire::PeopleChannelIntent::Mail,
        "address" => wire::PeopleChannelIntent::Map,
        _ => wire::PeopleChannelIntent::Copy,
    }
}

/// The verb a channel's action is called: "Call", "Email", "Open map", "Copy".
#[must_use]
pub fn channel_action(locale: Locale, intent: wire::PeopleChannelIntent) -> String {
    match intent {
        wire::PeopleChannelIntent::Call => words::action_call(locale),
        wire::PeopleChannelIntent::Mail => words::action_mail(locale),
        wire::PeopleChannelIntent::Map => words::action_map(locale),
        _ => words::action_copy(locale),
    }
}

/// The cadences the editor offers; `Never` is the zero, and zero is never overdue.
pub const CADENCES: [i64; 5] = [0, 7, 14, 30, 90];

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    #[test]
    fn initials_are_first_and_last() {
        assert_eq!(initials("Dana Reyes"), "DR");
        assert_eq!(initials("Dana"), "D");
        assert_eq!(initials("  ada  king  lovelace "), "AL");
        assert_eq!(initials("   "), "?");
    }

    /// A LEAP-DAY BIRTHDAY IS THE 28TH IN A COMMON YEAR: the core's `in_days` clamps it
    /// (`dates.rs`), and the day shown is that day, not the `MM-DD` that year lacks.
    #[test]
    fn a_leap_day_birthday_falls_on_the_twenty_eighth_in_a_common_year() {
        // 2025 is a common year: from 1 February it is 27 days away.
        assert_eq!(day_label(EN, "2025-02-01", Some(27), "02-29"), "28 February");
        // In a leap year the day exists and is used.
        assert_eq!(day_label(EN, "2024-02-01", Some(28), "02-29"), "29 February");
        // After this year's, it is next year's: 1 March 2025 to 28 February 2026.
        assert_eq!(day_label(EN, "2025-03-01", Some(364), "02-29"), "28 February");
    }

    #[test]
    fn a_date_the_core_could_not_place_keeps_its_stored_day() {
        assert_eq!(day_label(EN, "2026-10-24", None, "08-14"), "14 August");
        assert_eq!(day_label(EN, "not a day", Some(3), "08-14"), "14 August");
    }

    #[test]
    fn a_birthday_in_days_reads_as_words() {
        assert_eq!(in_days(EN, 0), "Today");
        assert_eq!(in_days(EN, 1), "Tomorrow");
        assert_eq!(in_days(EN, 12), "In 12 days");
        assert_eq!(month_day(EN, "08-14"), "14 August");
        assert_eq!(month_day(EN, "nope"), "nope");
        assert_eq!(month_day(EN, "13-01"), "13-01");
    }

    /// "LAST TOUCH" COUNTS THE MEMBER'S DAYS: the civil day the core read the touch on against
    /// today. A touch three hours ago across midnight is yesterday, whatever elapsed time says.
    #[test]
    fn a_last_touch_is_counted_in_the_members_days_and_not_in_elapsed_time() {
        assert_eq!(last_touch(EN, true, "2026-10-23", "2026-10-24", 0), "Last touch yesterday");
        assert_eq!(last_touch(EN, true, "2026-10-24", "2026-10-24", 3), "Last touch today");
        assert_eq!(last_touch(EN, true, "2026-10-12", "2026-10-24", 11), "Last touch 12 days ago");
        // A zone that resolved no day keeps the core's own count.
        assert_eq!(last_touch(EN, true, "", "2026-10-24", 5), "Last touch 5 days ago");
        assert_eq!(last_touch(EN, false, "", "2026-10-24", 0), "No touch logged yet");
    }

    #[test]
    fn a_cadence_is_every_n_days_or_none() {
        assert_eq!(cadence(EN, 0), "No cadence");
        assert_eq!(cadence(EN, 1), "Every day");
        assert_eq!(cadence(EN, 14), "Every 14 days");
    }
}
