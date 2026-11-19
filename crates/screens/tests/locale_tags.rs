//! EVERY LOCALE TAG RESOLVES TO A LANGUAGE THE CATALOG SPEAKS (#1202, S12).
//!
//! The catalog speaks one language, English. A phone sends any BCP 47 tag; none may panic, find a
//! missing key or come back empty, and a counted sentence picks its plural form from the count.

use centraid_screens::strings::{self, Locale, Plural};

const TAGS: &[&str] = &[
    "",
    "en",
    "en-US",
    "en-GB",
    "de",
    "de-DE",
    "fr-FR",
    "es-419",
    "ja-JP",
    "ko",
    "zh-Hans-CN",
    "ar-SA",
    "he-IL",
    "hi-IN",
    "pt_BR",
    "ru",
    "tr-TR",
    "und",
    "x-private",
    "not a tag",
];

#[test]
fn every_tag_resolves_and_the_same_catalog_answers_for_all() {
    let english = strings::counter_title(Locale::En);
    assert!(!english.is_empty());
    for tag in TAGS {
        let locale = Locale::from_tag(tag);
        assert_eq!(locale, Locale::En, "{tag:?}");
        assert_eq!(strings::counter_title(locale), english, "{tag:?}");
        assert!(!strings::counter_loading(locale).is_empty(), "{tag:?}");
        assert!(
            !strings::counter_count(locale, 0).contains("{n}"),
            "{tag:?}"
        );
    }
}

#[test]
fn a_counted_sentence_takes_its_form_from_the_count_and_fills_the_number() {
    let locale = Locale::from_tag("de-DE");
    assert_eq!(locale.plural(1), Plural::One);
    for n in [0_u64, 2, 11, 100, u64::MAX] {
        assert_eq!(locale.plural(n), Plural::Other, "{n}");
    }
    assert_eq!(strings::counter_count(locale, 1), "1 upcoming event");
    assert_eq!(strings::counter_count(locale, 3), "3 upcoming events");
}
